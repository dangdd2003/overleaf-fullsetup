# AI Assist: tool surface and starter harness

Date: 2026-09-14
Status: design, awaiting review

## Problem

Two parts of the `ai-assist` module have grown past the shape they were
designed for.

**The tool surface has one god-tool and an inconsistent param vocabulary.**
`project_map` takes five parameters, three of which are legal only for one
value of `view`: `section` for `outline`, `glob` for `files`, `kind` and
`undefinedOnly` for `references`. An illegal combination is silently ignored
rather than rejected, so a model that guesses wrong gets a plausible-looking
empty answer and no signal that it asked the wrong question. Worse, the same
parameter name means different things in adjacent tools: `read_file.path` is an
exact path while `search_project.path` is a glob. Every tool description
currently ends with a negative disambiguation clause — "Not for structure —
project_map answers those", "Not for creating files — create_file does that" —
which is direct evidence that the names and signatures do not disambiguate
themselves.

**Starter suggestions freeze for the session.** `use-project-starters.ts` sets
`settledRef` after the first successful compute and then early-returns on every
subsequent run unless the user clicks "New chat". A user who fixes all their
compile errors and recompiles still sees *"Fix 5 compile errors"*, and clicking
it sends the model a prompt about errors that no longer exist.

Separately, mutation safety currently rests on each tool remembering to declare
`suspends: true`. A future tool that writes to the project and forgets the flag
would execute without asking the user.

## Goals

- A tool surface a model can use correctly without trial and error: one purpose
  per tool, no mode-conditional parameters, one meaning per parameter name.
- No redundancy. Exactly one way to accomplish each thing.
- Every mutation gated on explicit user approval, guaranteed structurally
  rather than per-tool.
- Starter suggestions that track the project as it changes.
- Better project understanding in the context envelope, without spending a
  provider round trip to get it.

## Non-goals

- No new capabilities. No `delete_file`, no `rename_file`, no project-history
  tool. The tool count grows only because one god-tool is split.
- No change to `MAX_STARTERS`; five starters on startup, matching Overleaf
  Cloud.
- No change to the provider abstraction, the streaming layer, or the approval
  UI itself.

## Part 1 — the tool surface

### The split

`project_map` becomes four single-purpose tools. Nothing else is added.

| # | Tool | Parameters | Mutates |
| --- | --- | --- | --- |
| 1 | `list_files` | `glob?` | no |
| 2 | `read_file` | `path`, `from?`, `to?` | no |
| 3 | `search_text` | `query`, `glob?`, `regex?`, `caseSensitive?`, `contextLines?` | no |
| 4 | `get_outline` | `section?` | no |
| 5 | `get_references` | `kind?`, `unresolvedOnly?` | no |
| 6 | `get_packages` | — | no |
| 7 | `compile_project` | — | no |
| 8 | `get_compile_result` | `severity?`, `limit?`, `includeRaw?` | no |
| 9 | `edit_file` | `path`, `oldText`, `newText` | **yes** |
| 10 | `create_file` | `path`, `content` | **yes** |

Ten tools, every one with at most five parameters and none with a parameter
whose legality depends on another parameter's value.

`compile_project` and `get_compile_result` stay separate despite describing the
same subject. Their cost profiles differ by orders of magnitude — one triggers
a real LaTeX build, the other reads a result already in memory — and collapsing
them behind a `rebuild` boolean would hide that difference behind a parameter
the model has no cost intuition about.

### Parameter vocabulary

These meanings hold across every tool, with no exceptions:

- `path` — an exact file path relative to the project root. Never a pattern.
- `glob` — a pattern matching zero or more files, such as `sections/*.tex`.
- `from` / `to` — 1-indexed inclusive line numbers.
- `limit` — a maximum number of results.
- `kind` — a discriminator over a closed enum, always documented inline.

This resolves the current trap where `search_project.path` accepts a glob while
`read_file.path` rejects one. `search_text` takes `glob`; `read_file` takes
`path`.

The complete set of renames:

| Before | After | Reason |
| --- | --- | --- |
| `search_project` | `search_text` | Names what it searches, not where |
| `get_compile_log` | `get_compile_result` | It returns the parsed result, not a log |
| `project_map view=files` | `list_files` | Split |
| `project_map view=outline` | `get_outline` | Split |
| `project_map view=references` | `get_references` | Split |
| `project_map view=packages` | `get_packages` | Split |
| `search_project.path` | `search_text.glob` | Vocabulary: it is a pattern |
| `get_compile_log.maxEntries` | `get_compile_result.limit` | Vocabulary |
| `project_map.undefinedOnly` | `get_references.unresolvedOnly` | Matches the field it filters, `ReferenceUse.resolved` |
| `read_file.section` | *(deleted)* | Redundant with `get_outline(section)` |

`get_references.kind` keeps its existing enum: `labels`, `refs`, `citations`,
`all`, defaulting to `all`. `get_compile_result.severity` keeps `errors`,
`warnings`, `all`, defaulting to `all`.

### Redundancy removed

`read_file.section` is deleted. Today both `read_file` and `project_map` accept
a `section` parameter meaning different things — one reads a section's text,
the other returns a section's subtree. The replacement is a single path:
`get_outline(section)` returns the line range, then `read_file(path, from, to)`
reads it. One way to do each thing.

Tool descriptions lose their "Not for X — Y does that" clauses. Those exist
only because the current names overlap; once each tool has one purpose the
description can simply state that purpose. Descriptions state what the tool
does and when to reach for it, and nothing about what it is not.

### Approval architecture

`AgentTool` gains a `mutates: boolean` field. The existing `suspends` field is
about control flow — whether the runner must pause — while `mutates` is about
consequence, and the two must not be conflated: a future tool could suspend for
a reason other than a write.

The runner refuses to execute any tool with `mutates: true` unless it holds an
explicit user decision for that call. This is enforced in `run-agent.ts`, not
in the tools, so a tool that neglects to wire up approval fails closed rather
than writing silently.

Two tests guard this:

1. Every tool in the registry that can write to the project is marked
   `mutates: true`. Enumerated over `TOOLS` so a newly added tool is covered
   automatically.
2. The runner, given a mutating tool call and no approval decision, does not
   invoke the tool's `execute`.

The `FIX_TOOLS` subset used by the compile-error panel continues to exclude
`compile_project` and `create_file`; with the split it also excludes nothing
else, so a fix run gets tools 1–6, 8, and 9.

### Legacy stored calls

Conversations and fix runs persist `{ name, args, result }`, so stored history
contains tool names and parameter shapes that no longer exist. Rather than
migrate or discard that history, the tool-call renderer gains a generic
fallback: a call whose name is not in the current registry renders as its name
plus its arguments as formatted JSON, with no bespoke summary line or detail
view.

This keeps old conversations readable indefinitely, adds no migration code that
must be kept correct through future renames, and loses no user data. The cost
is one fallback branch in `tool-call-card.tsx` and `tool-call-detail.tsx`.

## Part 2 — the starter harness

### Recomputation

`useProjectStarters` currently freezes after its first successful compute.
Replace `settledRef` with a dependency on a cheap recomputation key, defined as
the string concatenation of:

- `ProjectIndex.hash` — already computed by the indexer, and already the value
  used to decide whether the index itself can be reused.
- The last compile's status and its error and warning counts. Counts rather
  than contents: a recompile that produces the same number of the same kinds of
  entry cannot change which starter rules fire, since every compile-driven rule
  gates on a count or on emptiness.
- `refreshSeed`, so "New chat" still forces a reshuffle of the fallback pool.

Comparing that key is an equality test on values that already exist, not a
rebuild. When it is unchanged the effect returns early exactly as today.

Recomputation keeps the current zero-blink property: the previous list stays on
screen until the new one resolves, then swaps. The localStorage cache continues
to seed the first paint synchronously.

### One new rule

`fix_duplicate_labels`, priority 87, between `resolve_broken_refs` (85) and
`add_missing_bib_entries` (88).

Fires when `index.references.duplicateLabels` is non-empty. This signal is
already extracted by the indexer and already rendered by the references tool,
but no starter has ever used it. Duplicate labels are a nastier defect than
broken ones: a broken `\ref` renders a visible `??`, while a duplicated label
makes `\ref` resolve silently to the wrong target, so the document compiles
clean and is wrong.

Label: `Fix N duplicate labels`. Follows the existing pluralised-count pattern,
so it needs a matching literal `t()` call in `agent-empty-state.tsx` and an
entry in `locales/en.json` — the translation scan is static and only sees
string-literal keys.

No other rules are added. The remaining index signals are already used.

### Per-starter harness

`Starter` gains `oneShot: boolean`.

The value is derived from which pool the starter came from rather than
hand-maintained per starter:

- **Derived rules** (the 12 priority-ordered rules, plus the new one) are
  `oneShot: true`. Each names a concrete target and a concrete deliverable — a
  specific file, a specific count, a specific change.
- **Generic fallbacks** (the 7 shuffled defaults) are `oneShot: false`. Each is
  an open-ended ask with no target; "Generate a table" cannot be completed in
  one shot without knowing what the table is of.

Deriving from the pool keeps the two behaviours legible and means a new rule
gets the right harness by construction.

A `oneShot` starter's prompt is wrapped in a task block before sending. A
non-`oneShot` starter's prompt is sent as an ordinary user message, exactly as
today.

### The task block

The system prompt's `# One-click tasks` section currently asserts that a turn
carrying `<task>` came from a button that "has no reply box: nobody can answer
you". That is true of the compile-error panel and false of a chat starter,
which has a composer directly beneath it. Sending starters through the existing
block would instruct the model to behave as though the user were unreachable
when they are not.

The block gains a `reply` attribute:

- `<task reply="none">` — the compile-error panel. Current behaviour unchanged:
  never ask a question, finish in this run, output shape dictated by the task.
- `<task reply="chat">` — a chat starter. Shares the core contract (finish the
  whole job in this run; never end by offering to do the work you were asked to
  do). Differs in one respect: a genuinely ambiguous choice may be raised, but
  only after everything unambiguous has been done.

The system prompt section is rewritten to describe both variants. The existing
fix-run task builder emits `reply="none"`; the new starter task builder emits
`reply="chat"`.

### Outline in the context envelope

`<project-context>` currently carries file counts, top-level directory names,
compile status, the open file, the selection and attachments — but not the
section tree. Every structural question therefore spends a full provider round
trip on `get_outline` before any real work begins.

Add a compact `<outline>` block: section titles with their line ranges, capped
at 40 entries with an overflow count. Delta-encoded against a fingerprint
exactly as `<files>` already is, so an unchanged turn collapses to
`unchanged since turn N`.

The index is already built and hashed client-side, so this costs no extra work
to produce. It sits inside the cached prefix, so its token cost is paid once
per conversation while the round trip it removes would otherwise recur.

When the outline is empty — a project with no sections — the block is omitted
entirely rather than rendered empty.

### Advanced tools section

The "Advanced tools" section currently holds exactly one entry, which is a
header above a single button. With `duplicateLabels` now surfaced, a
reference-integrity audit is its natural sibling: one prompt that checks
labels, refs and citations together and reports what does not resolve.

This is the one item in this spec chosen without explicit confirmation; it was
raised during design and the reviewer said "go" without ruling on it. It is
isolated to `agent-empty-state.tsx` and can be struck from the plan without
affecting anything else.

## Sequencing

The two parts are independent and can land in either order. Part 1 touches the
tool registry, the runner, the system prompt and the two tool renderers; Part 2
touches the starter derivation, the empty state, the envelope and the system
prompt. Their only overlap is the system prompt, which each edits in a
different section.

If the implementation plan proves large, Part 1 is the natural first plan: it
carries the approval-safety work, and the starter changes do not depend on it.

## Testing

- **Tool specs**: every tool's parameters validate against its own schema; no
  parameter is documented as conditional on another's value; the vocabulary
  rules hold (`path` never documented as accepting a pattern, `glob` never as
  an exact path).
- **Registry**: exactly the ten expected tools; `FIX_TOOLS` is the expected
  subset; every writing tool is `mutates: true`.
- **Runner**: a mutating call with no decision never reaches `execute`; a
  rejected decision never reaches `execute`; an approved one does.
- **Legacy rendering**: a stored call naming a tool absent from the registry
  renders its name and JSON args without throwing.
- **Starters**: the list recomputes when the index hash changes; it does not
  recompute when nothing changed; the previous list stays visible during
  recomputation; `fix_duplicate_labels` fires only on duplicates; derived rules
  are `oneShot` and fallbacks are not; exactly five starters are returned.
- **Task block**: the fix path emits `reply="none"`, the starter path
  `reply="chat"`; a non-`oneShot` starter emits no task block.
- **Envelope**: the outline renders with ranges, caps at 40 with an overflow
  count, collapses to `unchanged since turn N` on an unchanged turn, and is
  omitted for a project with no sections.

## Risks

- **Ten tool schemas is a larger cached prefix than seven.** The specs sit in
  the cached tool array, so the cost is paid once per conversation, and the
  split removes the retries a wrong `view`/param pairing currently causes.
- **Renaming every index tool at once invalidates the provider cache for
  in-flight conversations.** A one-time cost on upgrade, not ongoing.
- **The envelope outline could be large in a book-length project.** Capped at
  40 entries with an overflow count for exactly this reason.

## Out of scope, noted for later

- Content-aware starters. Every rule keys off structure and compile state;
  nothing keys off what the document is about. That would need a cheap
  one-shot model call over the outline and abstract, cached per index hash.
- A project-history tool. "Review what I changed" is a natural request in a
  live editor and the agent is currently blind to it, but it needs the Overleaf
  history API and is a feature rather than a cleanup.
