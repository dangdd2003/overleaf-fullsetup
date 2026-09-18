# AI Assist Agent Context Optimisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Rebuild how the AI Assist agent feeds context to a model — a constant system prompt, a cache-stable `<project-context>` envelope frozen at send time, a token budget with deterministic elision, four LaTeX-aware tools, and `@`-mention attachment of files and line ranges.

**Architecture:** A new `agent/context/` unit of pure functions owns request assembly. The system prompt becomes a constant with zero project data. Project state is rendered into an envelope **once, when the user sends a message**, and persisted on the transcript entry, so every turn's request array is a byte-exact extension of the previous turn's — which is what makes prompt caching work on all three providers. `buildRequest` concatenates that frozen history, runs a budget pass that elides stale tool results oldest-first, and emits explicit cache breakpoints the provider clients honour.

**Tech Stack:** React 18 + TypeScript, CodeMirror 6, mocha + chai + `@testing-library/react` + `fetch-mock` (frontend unit tests), the module's existing `OpenAiClient` / `AnthropicClient` / `OllamaClient` / `parseSseFrames`.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-11-ai-assist-context-optimisation-design.md`

## Global Constraints

- **Never run `git` write commands.** No `git add`, `git commit`, `git stash`, `git branch`, `git push`. The repository owner requires every git action to be explicitly requested and reconfirmed. Leave all work uncommitted in the working tree. Each task below ends with a verification step, not a commit step.
- All work happens in the `ai-assist` worktree at `.claude/worktrees/ai-assist`. Do not `cd` to the main checkout.
- Paths in **Files:** blocks are relative to `overleaf/services/web/`.
- Test commands run from `overleaf/services/web`. The runner is:
  `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js <path>`
- The module stays behind `AI_ASSIST_ENABLED`. With the flag unset, nothing in this plan may change upstream Overleaf CE behaviour.
- **No server-side code.** The module has no router and gains none. No inference proxy, no stored credentials, no stored transcripts. Requests go browser → provider with the user's own key.
- Everything under `agent/context/` must be a pure function over plain data. No `react`, no `@codemirror/*`, no `fetch` imports in that directory.
- Test helpers live under `test/frontend/js/**/helpers/`, which the mocha glob ignores.
- The web unit suite has pre-existing failures on clean `main`. Judge each task only against the test files it touches.

---

## File Structure

**New — `modules/ai-assist/frontend/js/features/ai-assist/agent/context/`**

| File | Responsibility |
|---|---|
| `system-prompt.ts` | The `SYSTEM_PROMPT` constant. No project data, no functions. |
| `types.ts` | `ContextSnapshot`, `EnvelopeState`, `AttachmentRef`, `Attachment`, `CacheHints`, `Limits`. Shared vocabulary so no task invents its own. |
| `project-context.ts` | `renderEnvelope()` — `ContextSnapshot` + previous `EnvelopeState` → envelope text and new state. Delta-encodes the file listing. |
| `attachments.ts` | `renderAttachments()` — `Attachment[]` → the envelope's `<attachments>` section. |
| `outline.ts` | Pure LaTeX structure parser: sections, `\input`/`\include` graph, documentclass, packages. |
| `references.ts` | Pure extractor: `\label`, `\ref`/`\eqref`/`\autoref`, `\cite`, `.bib` keys, with resolution status. |
| `budget.ts` | `estimateTokens()` and `applyBudget()` — deterministic elision of stale tool results. |
| `build-request.ts` | `buildRequest()` — transcript → `{ system, messages, cacheHints }`. Orchestrator; owns no rendering logic itself. |

**New — tools** (`agent/tools/`): `outline-project.ts`, `list-references.ts`, `compile-log.ts`, `create-file.ts`.

**Modified**

| File | Change |
|---|---|
| `agent/system-prompt.ts` | Deleted; replaced by `context/system-prompt.ts`. |
| `agent/project-handle.ts` | `ProjectFile` gains `lines`; adds `openFile()`, `lastCompile()`, `createFile()`, `LastCompile`. |
| `agent/use-project-handle.ts` | Implements the three new handle methods. |
| `agent/agent-messages.ts` | User entry gains `contextText`, `envelopeState`, `attachments`; the duplicate selection injection at line 51 is removed. |
| `agent/run-agent.ts` | Calls `buildRequest`; `MAX_STEPS` 12 → 30; per-provider output limit; `contextExhausted` error. |
| `agent/tools/registry.ts` | `AgentTool` gains optional `render()`; registers the four new tools. |
| `agent/tools/read-file.ts` | Returns `totalLines`; names the next range; implements `render()`. |
| `agent/tools/search-project.ts` | Adds `path` glob and `contextLines`; reports a true total. |
| `providers/types.ts` | `ChatRequest` gains `cacheHints`; `ProviderSettings` gains `contextWindow` and `maxOutputTokens`; adds `DEFAULT_LIMITS`. |
| `providers/anthropic.ts` | `cache_control` on system, last tool spec, last stable message. |
| `providers/openai.ts` | Sends `prompt_cache_key`. |
| `components/provider-form.tsx` | Context-window and max-output-tokens inputs. |
| `components/agent/agent-composer.tsx` | `@` typeahead, line ranges, attachment chips, live paperclip. |
| `components/agent/agent-panel.tsx` | Renders the envelope at send time; handles `contextExhausted`. |
| `components/agent/edit-approval-card.tsx` | All-additions rendering for `create_file`. |
| `test/frontend/js/agent/helpers/fake-handle.ts` | Implements the three new handle methods. |

---

## Phase 1 — Context assembly

### Task 1: The constant system prompt

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/system-prompt.ts`
- Delete: `modules/ai-assist/frontend/js/features/ai-assist/agent/system-prompt.ts`
- Test: `modules/ai-assist/test/frontend/js/context/system-prompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SYSTEM_PROMPT: string`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/context/system-prompt.test.ts`:

```ts
import { expect } from 'chai'
import { SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/system-prompt'

describe('SYSTEM_PROMPT', function () {
  it('is a non-empty constant string', function () {
    expect(SYSTEM_PROMPT).to.be.a('string')
    expect(SYSTEM_PROMPT.length).to.be.greaterThan(200)
  })

  it('states the identity and the live-editing environment', function () {
    expect(SYSTEM_PROMPT).to.match(/Overleaf/)
    expect(SYSTEM_PROMPT).to.match(/LaTeX/)
  })

  it('documents every edit_file failure status and what to do', function () {
    for (const status of ['noMatch', 'ambiguous', 'rejected', 'drifted']) {
      expect(SYSTEM_PROMPT, `missing guidance for ${status}`).to.include(status)
    }
  })

  it('names the cheap structural tools so the model prefers them', function () {
    expect(SYSTEM_PROMPT).to.include('outline_project')
    expect(SYSTEM_PROMPT).to.include('list_references')
    expect(SYSTEM_PROMPT).to.include('search_project')
  })

  it('carries a compile policy and an honesty rule', function () {
    expect(SYSTEM_PROMPT.toLowerCase()).to.include('compile')
    expect(SYSTEM_PROMPT.toLowerCase()).to.match(/do not invent|never invent/)
  })

  // This is the test that protects the caching design. If project data ever
  // leaks back into the system prompt, every provider's cache dies silently.
  it('contains no project data and no interpolation', function () {
    expect(SYSTEM_PROMPT).to.not.include('${')
    expect(SYSTEM_PROMPT).to.not.match(/\.tex\b/)
    expect(SYSTEM_PROMPT).to.not.include('Project files:')
  })
})
```

- [x] **Step 2: Run test to verify it fails**

From `overleaf/services/web`:

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/system-prompt.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/context/system-prompt'`.

- [x] **Step 3: Write the constant**

Create `modules/ai-assist/frontend/js/features/ai-assist/agent/context/system-prompt.ts`:

```ts
/**
 * The agent's system prompt.
 *
 * This is a constant on purpose. Every byte of project state lives in the
 * <project-context> envelope on the user turn instead, which is what lets
 * Anthropic's explicit cache and OpenAI's automatic prefix cache hit. Adding an
 * interpolated value here would silently cost a full re-read on every request.
 */
export const SYSTEM_PROMPT = [
  'You are an AI assistant embedded in the Overleaf LaTeX editor. You are',
  "working inside the user's real project, which they are editing at the same",
  'time as you. Treat the project as live: it can change under you.',
  '',
  '# Responding',
  '',
  'Be concise. Do not restate the question or narrate what you are about to do.',
  'Answer in Markdown. Write LaTeX commands in backticks, like `\\includegraphics`.',
  'When you have changed something, say what you changed and why, in one or two',
  'sentences.',
  '',
  '# Working',
  '',
  'Orient before you read, and read before you edit. Prefer the smallest change',
  'that solves the problem. Do not refactor code the user did not ask you to',
  'touch.',
  '',
  'Each user turn begins with a <project-context> block describing the project',
  'as it was when the user sent that message: the file listing, the last compile',
  'result, which file is open, the current selection, and anything the user',
  'attached. The newest block is the current one; earlier blocks are historical',
  'snapshots and may be stale.',
  '',
  '# Choosing a tool',
  '',
  '- `outline_project` — section structure, the \\input/\\include graph, the',
  '  documentclass and packages. Use this to orient on an unfamiliar project.',
  '  It is far cheaper than reading files.',
  '- `list_references` — every \\label, \\ref and \\cite with whether it',
  '  resolves. Use this for any question about undefined references, missing',
  '  citations, or duplicate labels. Never read files to answer those.',
  '- `search_project` — find a string or pattern. Use this instead of guessing',
  '  at a path.',
  '- `read_file` — read a specific file, or a line range of one. Reach for this',
  "  after the cheaper tools have told you where to look.",
  '- `list_files` — the full listing, when the context block truncated it.',
  '- `edit_file` — change a file. See the contract below.',
  '- `create_file` — add a new file. It must not already exist.',
  '- `compile_project` — build the project. See the compile policy below.',
  '- `get_compile_log` — the last build result without rebuilding. Prefer this',
  '  over `compile_project` when you only need to see what already failed.',
  '',
  '# The edit contract',
  '',
  'To edit, you give `oldText` and `newText`. `oldText` must appear exactly once',
  'in the file. Include surrounding lines if a short anchor would be ambiguous.',
  '',
  'Every edit is shown to the user as a diff before it is applied, and they may',
  'reject it. Handle each outcome:',
  '',
  '- `noMatch` — your anchor is not in the file. Read the file again and copy',
  '  the span exactly. Do not guess at whitespace.',
  '- `ambiguous` — your anchor appears more than once. Widen it with more',
  '  surrounding context until it is unique.',
  '- `rejected` — the user declined. Do not send the same edit again. Ask what',
  '  they want instead.',
  '- `drifted` — the user typed while the diff was open. Re-read the file before',
  '  trying again.',
  '',
  '# Compiling',
  '',
  'After making edits that could affect the build, compile and check the result.',
  'Do not compile after prose-only or comment-only edits; a compile is slow and',
  'the user is waiting.',
  '',
  'Never claim a fix works without evidence. If you have not compiled since your',
  'edit, say that you have not verified it.',
  '',
  '# Honesty',
  '',
  'Do not invent citation keys, label names, package names, or command names. If',
  'a reference does not resolve or a package is not loaded, say so plainly and',
  'tell the user what would fix it.',
].join('\n')
```

- [x] **Step 4: Run test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/system-prompt.test.ts
```

Expected: PASS, 6 passing.

- [x] **Step 5: Delete the old builder and confirm nothing imports it**

Delete `modules/ai-assist/frontend/js/features/ai-assist/agent/system-prompt.ts`.

`run-agent.ts` still imports it and will not typecheck. That is expected and is repaired in Task 8. Confirm the only remaining reference is that one:

```bash
grep -rn "agent/system-prompt\|buildSystemPrompt" modules/ai-assist --include=*.ts --include=*.tsx
```

Expected: matches only in `agent/run-agent.ts`. If a test file also matches, delete that test file — its subject no longer exists.

- [x] **Step 6: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

Expected: the new files and the deletion are listed as modified/untracked. Leave them uncommitted.

---

### Task 2: Shared context types

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/types.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts`
- Test: `modules/ai-assist/test/frontend/js/context/types.test.ts`

**Interfaces:**
- Consumes: `ProjectFile`, `CompileOutcome` from `agent/project-handle`.
- Produces: `ContextSnapshot`, `EnvelopeState`, `AttachmentRef`, `Attachment`, `CacheHints`, `Limits`, `Selection`. Every later task imports its vocabulary from here.

This task is mostly type declarations, so the test asserts the one thing types cannot: that `ProjectFile.lines` is actually populated and that the fingerprint helper is stable.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/context/types.test.ts`:

```ts
import { expect } from 'chai'
import { fingerprintFiles } from '../../../../frontend/js/features/ai-assist/agent/context/types'
import type { ProjectFile } from '../../../../frontend/js/features/ai-assist/agent/project-handle'

const files: ProjectFile[] = [
  { path: 'main.tex', type: 'doc', size: 120, lines: 8 },
  { path: 'refs.bib', type: 'doc', size: 40, lines: 3 },
]

describe('fingerprintFiles', function () {
  it('is stable for the same listing', function () {
    expect(fingerprintFiles(files)).to.equal(fingerprintFiles(files))
  })

  it('ignores ordering, because the file tree does not promise one', function () {
    expect(fingerprintFiles(files)).to.equal(fingerprintFiles([...files].reverse()))
  })

  it('changes when a file is added', function () {
    const extra: ProjectFile[] = [
      ...files,
      { path: 'intro.tex', type: 'doc', size: 10, lines: 2 },
    ]
    expect(fingerprintFiles(extra)).to.not.equal(fingerprintFiles(files))
  })

  it('changes when a line count changes', function () {
    const grown: ProjectFile[] = [{ ...files[0], lines: 9 }, files[1]]
    expect(fingerprintFiles(grown)).to.not.equal(fingerprintFiles(files))
  })

  // Byte size churns on every keystroke. If it fed the fingerprint, the file
  // listing would re-render every turn and the cache would never hold.
  it('does not change when only the byte size changes', function () {
    const retyped: ProjectFile[] = [{ ...files[0], size: 121 }, files[1]]
    expect(fingerprintFiles(retyped)).to.equal(fingerprintFiles(files))
  })
})
```

- [x] **Step 2: Run test to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/types.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/context/types'`.

- [x] **Step 3: Extend the handle types**

In `agent/project-handle.ts`, add `lines` to `ProjectFile`, add `LastCompile`, and add the three methods to the interface:

```ts
export type ProjectFile = {
  path: string
  type: 'doc' | 'binary'
  size: number
  /** Line count for docs; undefined for binaries. Models pick ranges by line. */
  lines?: number
}

/** The last compile, including the raw log `get_compile_log` excerpts from. */
export type LastCompile = CompileOutcome & { rawLog: string | null }
```

and inside `export interface ProjectHandle`, after `compile()`:

```ts
  /** The document the user is looking at, if any. */
  openFile(): { path: string; cursorLine: number | null } | null
  /** The last compile result, without triggering a new one. */
  lastCompile(): LastCompile | null
  /** Create a file that does not exist yet, behind the same approval card. */
  createFile(request: { path: string; content: string }): Promise<EditOutcome>
```

- [x] **Step 4: Write the shared types**

Create `agent/context/types.ts`:

```ts
import { CompileOutcome, ProjectFile } from '../project-handle'

export type Selection = {
  path: string
  from: number
  to: number
  text: string
}

/** Everything the envelope can describe, captured at one instant. */
export type ContextSnapshot = {
  rootDocPath: string | null
  files: ProjectFile[]
  openFile: { path: string; cursorLine: number | null } | null
  selection: Selection | null
  compile: Pick<CompileOutcome, 'status'> & {
    errorCount: number
    warningCount: number
  } | null
}

/** Carried on a user entry so the next turn can delta-encode against it. */
export type EnvelopeState = {
  turn: number
  filesFingerprint: string
}

/** What the composer holds before the message is sent. */
export type AttachmentRef = {
  path: string
  from?: number
  to?: number
}

/** What the transcript holds after it. `text: null` means the file is gone. */
export type Attachment = AttachmentRef & { text: string | null }

export type CacheHints = {
  cacheSystem: boolean
  cacheTools: boolean
  /** Index into `messages` of the last message stable across turns. */
  lastStableMessage: number | null
  /** Stable per-project key for providers with keyed caches. */
  cacheKey?: string
}

export type Limits = {
  contextWindow: number
  maxOutputTokens: number
}

/**
 * A cheap identity for a file listing.
 *
 * Deliberately excludes byte size: it changes on every keystroke, and feeding
 * it in here would re-emit the whole listing every turn and defeat the cache.
 */
export function fingerprintFiles(files: ProjectFile[]): string {
  return files
    .map(file => `${file.path}:${file.type}:${file.lines ?? ''}`)
    .sort()
    .join('|')
}
```

- [x] **Step 5: Populate `lines` in the real handle**

In `agent/use-project-handle.ts`, in `listFiles`, give docs a line count:

```ts
    const docs = projectSnapshot.getDocPaths().map(path => {
      const contents = projectSnapshot.getDocContents(path)
      return {
        path,
        type: 'doc' as const,
        size: contents?.length ?? 0,
        lines: contents ? contents.split('\n').length : 0,
      }
    })
```

- [x] **Step 6: Run test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/types.test.ts
```

Expected: PASS, 5 passing.

- [x] **Step 7: Verify — do not commit**

`ProjectHandle` now declares three methods nothing implements, so `use-project-handle.ts` and `fake-handle.ts` will not typecheck. That is expected; Task 3 implements them. Leave everything uncommitted.

---

### Task 3: Handle additions — open file, last compile, fake handle

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Modify: `modules/ai-assist/test/frontend/js/agent/helpers/fake-handle.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/handle-context.test.ts`

**Interfaces:**
- Consumes: `LastCompile`, `ProjectHandle` from Task 2.
- Produces: a `ProjectHandle` that implements `openFile()` and `lastCompile()`; `createFakeHandle` options `openFile`, `lastCompile`, `onCreate`, and per-doc `lines`. Later tasks build fakes with these options.

`createFile` is stubbed here only so the interface is satisfied; its real behaviour is Task 13.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/handle-context.test.ts`:

```ts
import { expect } from 'chai'
import { createFakeHandle } from './helpers/fake-handle'

describe('fake handle context accessors', function () {
  it('reports no open file and no compile by default', function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })
    expect(handle.openFile()).to.equal(null)
    expect(handle.lastCompile()).to.equal(null)
  })

  it('reports the configured open file and cursor line', function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'a\nb\nc' },
      openFile: { path: 'main.tex', cursorLine: 2 },
    })
    expect(handle.openFile()).to.deep.equal({ path: 'main.tex', cursorLine: 2 })
  })

  it('reports the last compile including its raw log', function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'x' },
      lastCompile: {
        status: 'failure',
        errors: [{ message: 'Undefined control sequence', file: 'main.tex', line: 3 }],
        warnings: [],
        rawLog: '! Undefined control sequence.\nl.3 \\foo',
      },
    })
    const compile = handle.lastCompile()
    expect(compile?.status).to.equal('failure')
    expect(compile?.errors).to.have.length(1)
    expect(compile?.rawLog).to.include('Undefined control sequence')
  })

  it('gives docs a line count in listFiles', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'a\nb\nc' } })
    const files = await handle.listFiles()
    expect(files[0].lines).to.equal(3)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/handle-context.test.ts
```

Expected: FAIL — `handle.openFile is not a function`.

- [x] **Step 3: Extend the fake handle**

In `test/frontend/js/agent/helpers/fake-handle.ts`, add to `FakeHandleOptions`:

```ts
  openFile?: { path: string; cursorLine: number | null } | null
  lastCompile?: LastCompile | null
  onCreate?: (request: { path: string; content: string }) => EditOutcome
```

import `LastCompile` alongside the existing type imports, give docs a line count in `listFiles`:

```ts
        ...Object.entries(docs).map(([path, text]) => ({
          path,
          type: 'doc' as const,
          size: text.length,
          lines: text.split('\n').length,
        })),
```

and add the three methods to the `handle` object:

```ts
    openFile: () => options.openFile ?? null,

    lastCompile: () => options.lastCompile ?? null,

    async createFile(request) {
      calls.push({ name: 'createFile', args: request })
      return options.onCreate ? options.onCreate(request) : { status: 'applied' }
    },
```

- [x] **Step 4: Run test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/handle-context.test.ts
```

Expected: PASS, 4 passing.

- [x] **Step 5: Implement the accessors in the real handle**

In `agent/use-project-handle.ts`, pull `currentDocumentId` from the editor manager context and track the cursor over the existing event bridge. Add near the existing `selectionRef`:

```ts
  const cursorLineRef = useRef<number | null>(null)

  useEventListener('aiAssist:agentCursor', (event: Event) => {
    const detail = (event as CustomEvent<{ line: number } | null>).detail
    cursorLineRef.current = detail?.line ?? null
  })
```

Destructure `currentDocumentId` from `useEditorManagerContext()` alongside `openDocWithId`, then add the callbacks:

```ts
  const openFile = useCallback(() => {
    if (!currentDocumentId || !fileTreeData) return null
    const path = pathInFolder(fileTreeData, currentDocumentId)
    if (!path) return null
    return { path, cursorLine: cursorLineRef.current }
  }, [currentDocumentId, fileTreeData])

  const lastCompile = useCallback((): LastCompile | null => {
    const entries = logEntriesRef.current
    if (!entries) return null
    const summarise = (list: any[] = []) =>
      list.map(entry => ({
        message: entry.message ?? '',
        file: entry.file ?? null,
        line: entry.line ?? null,
      }))
    return {
      status: entries.errors?.length ? 'failure' : 'success',
      errors: summarise(entries.errors),
      warnings: summarise(entries.warnings),
      rawLog: rawLogRef.current ?? null,
    }
  }, [])
```

Add `rawLog` to the `useLocalCompileContext()` destructuring and mirror it into a ref next to `logEntriesRef`:

```ts
  const { startCompile, logEntries, rawLog } = useLocalCompileContext()
  const rawLogRef = useRef(rawLog)
  rawLogRef.current = rawLog
```

Stub `createFile` for now — Task 13 replaces the body:

```ts
  const createFile = useCallback(
    async (_request: { path: string; content: string }): Promise<EditOutcome> => {
      return { status: 'rejected', note: 'File creation is not wired up yet.' }
    },
    []
  )
```

Add `openFile`, `lastCompile`, and `createFile` to the returned object and to the `useMemo` dependency array.

- [x] **Step 6: Run the whole agent suite to check nothing regressed**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent
```

Expected: everything that passed before still passes. `run-agent.test.ts` may fail on the deleted `system-prompt` import from Task 1 — that is expected until Task 8.

- [x] **Step 7: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

Expected: modified files listed, nothing staged, nothing committed.

---
### Task 4: The project-context envelope

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-context.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/attachments.ts`
- Test: `modules/ai-assist/test/frontend/js/context/project-context.test.ts`

**Interfaces:**
- Consumes: `ContextSnapshot`, `EnvelopeState`, `Attachment`, `fingerprintFiles` from Task 2.
- Produces:
  - `renderEnvelope({ snapshot, attachments, turn, previous }): { text: string; state: EnvelopeState }`
  - `renderAttachments(attachments: Attachment[]): string | null`
  - `MAX_LISTED_FILES: number`

The exact output format is asserted, not described. Later tasks depend on these bytes, so treat the test as the specification.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/context/project-context.test.ts`:

```ts
import { expect } from 'chai'
import { renderEnvelope, MAX_LISTED_FILES } from '../../../../frontend/js/features/ai-assist/agent/context/project-context'
import type { ContextSnapshot } from '../../../../frontend/js/features/ai-assist/agent/context/types'

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    rootDocPath: 'main.tex',
    files: [
      { path: 'main.tex', type: 'doc', size: 400, lines: 12 },
      { path: 'refs.bib', type: 'doc', size: 90, lines: 4 },
      { path: 'figures/plot.pdf', type: 'binary', size: 86016 },
    ],
    openFile: null,
    selection: null,
    compile: null,
    ...overrides,
  }
}

describe('renderEnvelope', function () {
  it('renders the full file listing on the first turn', function () {
    const { text } = renderEnvelope({
      snapshot: snapshot(),
      attachments: [],
      turn: 1,
      previous: null,
    })

    expect(text).to.include('<project-context turn="1">')
    expect(text).to.include('<files root="main.tex">')
    expect(text).to.include('main.tex')
    expect(text).to.include('12 lines')
    expect(text).to.include('84 KB')
    expect(text).to.include('</project-context>')
  })

  it('omits the root attribute when there is no root document', function () {
    const { text } = renderEnvelope({
      snapshot: snapshot({ rootDocPath: null }),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(text).to.include('<files>')
    expect(text).to.not.include('root=')
  })

  it('delta-encodes an unchanged listing against the previous turn', function () {
    const first = renderEnvelope({
      snapshot: snapshot(),
      attachments: [],
      turn: 1,
      previous: null,
    })
    const second = renderEnvelope({
      snapshot: snapshot(),
      attachments: [],
      turn: 2,
      previous: first.state,
    })

    expect(second.text).to.include('<files>unchanged since turn 1</files>')
    expect(second.text).to.not.include('refs.bib')
  })

  it('re-emits the listing in full when a file appears', function () {
    const first = renderEnvelope({
      snapshot: snapshot(),
      attachments: [],
      turn: 1,
      previous: null,
    })
    const grown = snapshot({
      files: [
        ...snapshot().files,
        { path: 'intro.tex', type: 'doc', size: 10, lines: 2 },
      ],
    })
    const second = renderEnvelope({
      snapshot: grown,
      attachments: [],
      turn: 2,
      previous: first.state,
    })

    expect(second.text).to.include('intro.tex')
    expect(second.text).to.not.include('unchanged since')
  })

  it('carries the turn forward in the state it returns', function () {
    const first = renderEnvelope({
      snapshot: snapshot(),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(first.state.turn).to.equal(1)
    expect(first.state.filesFingerprint).to.be.a('string').and.not.equal('')
  })

  it('reports compile health and points at the log when it failed', function () {
    const { text } = renderEnvelope({
      snapshot: snapshot({
        compile: { status: 'failure', errorCount: 2, warningCount: 5 },
      }),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(text).to.include(
      '<compile>failure - 2 errors, 5 warnings (call get_compile_log for detail)</compile>'
    )
  })

  it('singularises a lone error and stays quiet on a clean build', function () {
    const one = renderEnvelope({
      snapshot: snapshot({
        compile: { status: 'failure', errorCount: 1, warningCount: 1 },
      }),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(one.text).to.include('1 error, 1 warning')

    const clean = renderEnvelope({
      snapshot: snapshot({
        compile: { status: 'success', errorCount: 0, warningCount: 0 },
      }),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(clean.text).to.include('<compile>success - 0 errors, 0 warnings</compile>')
    expect(clean.text).to.not.include('get_compile_log')
  })

  it('says so when the project has never been compiled', function () {
    const { text } = renderEnvelope({
      snapshot: snapshot({ compile: null }),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(text).to.include('<compile>not compiled yet</compile>')
  })

  it('reports the open file with and without a cursor line', function () {
    const withCursor = renderEnvelope({
      snapshot: snapshot({ openFile: { path: 'main.tex', cursorLine: 12 } }),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(withCursor.text).to.include('<open-file>main.tex, cursor line 12</open-file>')

    const without = renderEnvelope({
      snapshot: snapshot({ openFile: { path: 'main.tex', cursorLine: null } }),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(without.text).to.include('<open-file>main.tex</open-file>')
  })

  it('renders a selection with its file and line range', function () {
    const { text } = renderEnvelope({
      snapshot: snapshot({
        selection: { path: 'main.tex', from: 4, to: 5, text: '\\section{A}\n\\label{sec:a}' },
      }),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(text).to.include('<selection file="main.tex" lines="4-5">')
    expect(text).to.include('\\label{sec:a}')
    expect(text).to.include('</selection>')
  })

  it('renders attachments, including one whose file has gone', function () {
    const { text } = renderEnvelope({
      snapshot: snapshot(),
      attachments: [
        { path: 'refs.bib', from: 1, to: 2, text: '@book{a,\n  title={A}' },
        { path: 'deleted.tex', text: null },
      ],
      turn: 1,
      previous: null,
    })
    expect(text).to.include('<attachments>')
    expect(text).to.include('<file path="refs.bib" lines="1-2">')
    expect(text).to.include('@book{a,')
    expect(text).to.include('<file path="deleted.tex">no longer in the project</file>')
  })

  it('omits every optional section when there is nothing to say', function () {
    const { text } = renderEnvelope({
      snapshot: snapshot(),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(text).to.not.include('<open-file>')
    expect(text).to.not.include('<selection')
    expect(text).to.not.include('<attachments>')
  })

  it('orders sections stable-first so the selection sits nearest the question', function () {
    const { text } = renderEnvelope({
      snapshot: snapshot({
        openFile: { path: 'main.tex', cursorLine: 3 },
        selection: { path: 'main.tex', from: 1, to: 1, text: 'x' },
        compile: { status: 'success', errorCount: 0, warningCount: 0 },
      }),
      attachments: [{ path: 'refs.bib', text: 'y' }],
      turn: 1,
      previous: null,
    })
    const order = ['<files', '<compile>', '<open-file>', '<selection', '<attachments>']
    const positions = order.map(marker => text.indexOf(marker))
    expect(positions).to.deep.equal([...positions].sort((a, b) => a - b))
    expect(positions.every(position => position > -1)).to.equal(true)
  })

  it('caps the listing and points at list_files beyond the cap', function () {
    const many = Array.from({ length: MAX_LISTED_FILES + 5 }, (_unused, index) => ({
      path: `chapter${index}.tex`,
      type: 'doc' as const,
      size: 10,
      lines: 2,
    }))
    const { text } = renderEnvelope({
      snapshot: snapshot({ files: many }),
      attachments: [],
      turn: 1,
      previous: null,
    })
    expect(text).to.include('(5 more; call list_files for all of them.)')
  })
})
```

- [x] **Step 2: Run test to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/project-context.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/context/project-context'`.

- [x] **Step 3: Write the attachment renderer**

Create `agent/context/attachments.ts`:

```ts
import { Attachment } from './types'

function label(attachment: Attachment) {
  return attachment.from && attachment.to
    ? `<file path="${attachment.path}" lines="${attachment.from}-${attachment.to}">`
    : `<file path="${attachment.path}">`
}

/**
 * Renders what the user explicitly pinned to the turn.
 *
 * A missing file renders as a note rather than an error: a conversation should
 * survive the user deleting something it once referred to.
 */
export function renderAttachments(attachments: Attachment[]): string | null {
  if (attachments.length === 0) return null

  const body = attachments.map(attachment => {
    if (attachment.text === null) {
      return `<file path="${attachment.path}">no longer in the project</file>`
    }
    return [label(attachment), attachment.text, '</file>'].join('\n')
  })

  return ['<attachments>', ...body, '</attachments>'].join('\n')
}
```

- [x] **Step 4: Write the envelope renderer**

Create `agent/context/project-context.ts`:

```ts
import { ProjectFile } from '../project-handle'
import { renderAttachments } from './attachments'
import {
  Attachment,
  ContextSnapshot,
  EnvelopeState,
  fingerprintFiles,
} from './types'

export const MAX_LISTED_FILES = 200

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function describe(file: ProjectFile) {
  if (file.type === 'binary') return `${Math.round(file.size / 1024)} KB`
  return plural(file.lines ?? 0, 'line')
}

function renderFiles(snapshot: ContextSnapshot, previous: EnvelopeState | null) {
  const fingerprint = fingerprintFiles(snapshot.files)

  if (previous && previous.filesFingerprint === fingerprint) {
    return {
      text: `<files>unchanged since turn ${previous.turn}</files>`,
      fingerprint,
    }
  }

  const listed = snapshot.files.slice(0, MAX_LISTED_FILES)
  const width = Math.max(...listed.map(file => file.path.length), 0) + 2
  const rows = listed.map(
    file =>
      `${file.path.padEnd(width)}${file.type.padEnd(8)}${describe(file)}`
  )

  if (snapshot.files.length > MAX_LISTED_FILES) {
    rows.push(
      `(${snapshot.files.length - MAX_LISTED_FILES} more; call list_files for all of them.)`
    )
  }

  const open = snapshot.rootDocPath
    ? `<files root="${snapshot.rootDocPath}">`
    : '<files>'

  return { text: [open, ...rows, '</files>'].join('\n'), fingerprint }
}

function renderCompile(snapshot: ContextSnapshot) {
  if (!snapshot.compile) return '<compile>not compiled yet</compile>'
  const { status, errorCount, warningCount } = snapshot.compile
  const counts = `${plural(errorCount, 'error')}, ${plural(warningCount, 'warning')}`
  const pointer = errorCount > 0 ? ' (call get_compile_log for detail)' : ''
  return `<compile>${status} - ${counts}${pointer}</compile>`
}

/**
 * Renders the block that is prefixed onto a user message and then frozen.
 *
 * It is rendered once, at send time, and never re-derived: re-deriving it from
 * a later snapshot would produce different bytes for the same historical turn
 * and break the prefix cache this whole design exists to keep.
 */
export function renderEnvelope({
  snapshot,
  attachments,
  turn,
  previous,
}: {
  snapshot: ContextSnapshot
  attachments: Attachment[]
  turn: number
  previous: EnvelopeState | null
}): { text: string; state: EnvelopeState } {
  const files = renderFiles(snapshot, previous)

  // Stable first, volatile last, so the selection and attachments end up
  // adjacent to the user's own words.
  const sections: string[] = [files.text, renderCompile(snapshot)]

  if (snapshot.openFile) {
    const { path, cursorLine } = snapshot.openFile
    sections.push(
      cursorLine === null
        ? `<open-file>${path}</open-file>`
        : `<open-file>${path}, cursor line ${cursorLine}</open-file>`
    )
  }

  if (snapshot.selection) {
    const { path, from, to, text } = snapshot.selection
    sections.push(
      `<selection file="${path}" lines="${from}-${to}">`,
      text,
      '</selection>'
    )
  }

  const rendered = renderAttachments(attachments)
  if (rendered) sections.push(rendered)

  return {
    text: [
      `<project-context turn="${turn}">`,
      ...sections,
      '</project-context>',
    ].join('\n'),
    state: { turn, filesFingerprint: files.fingerprint },
  }
}
```

- [x] **Step 5: Run test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/project-context.test.ts
```

Expected: PASS, 14 passing.

- [x] **Step 6: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

Expected: two new source files and one new test file, untracked. Nothing staged.

---

### Task 5: Token budget and elision

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/budget.ts`
- Test: `modules/ai-assist/test/frontend/js/context/budget.test.ts`

**Interfaces:**
- Consumes: `AgentMessage` from `providers/types`; `Limits` from Task 2.
- Produces:
  - `estimateTokens(text: string): number`
  - `estimateRequestTokens(system: string, messages: AgentMessage[]): number`
  - `applyBudget({ system, messages, limits }): { messages: AgentMessage[]; elided: number; exhausted: boolean }`
  - `CHARS_PER_TOKEN`, `MARGIN_FRACTION`, `KEEP_RECENT_TOOL_RESULTS`

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/context/budget.test.ts`:

```ts
import { expect } from 'chai'
import {
  applyBudget,
  estimateTokens,
  KEEP_RECENT_TOOL_RESULTS,
} from '../../../../frontend/js/features/ai-assist/agent/context/budget'
import type { AgentMessage } from '../../../../frontend/js/features/ai-assist/providers/types'

const BIG = 'x'.repeat(40000)

function conversation(toolResults: number): AgentMessage[] {
  const messages: AgentMessage[] = []
  for (let index = 0; index < toolResults; index++) {
    messages.push({ role: 'user', content: `question ${index}` })
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call-${index}`, name: 'read_file', args: { path: 'main.tex' } }],
    })
    messages.push({
      role: 'tool',
      toolCallId: `call-${index}`,
      name: 'read_file',
      content: BIG,
    })
  }
  messages.push({ role: 'user', content: 'the newest question' })
  return messages
}

describe('estimateTokens', function () {
  it('grows with length and never returns a negative', function () {
    expect(estimateTokens('')).to.equal(0)
    expect(estimateTokens('x'.repeat(370))).to.be.greaterThan(50)
    expect(estimateTokens('x'.repeat(3700))).to.be.greaterThan(
      estimateTokens('x'.repeat(370))
    )
  })
})

describe('applyBudget', function () {
  const limits = { contextWindow: 8000, maxOutputTokens: 1000 }

  it('leaves a small conversation untouched', function () {
    const messages: AgentMessage[] = [{ role: 'user', content: 'hello' }]
    const result = applyBudget({ system: 'sys', messages, limits })
    expect(result.messages).to.deep.equal(messages)
    expect(result.elided).to.equal(0)
    expect(result.exhausted).to.equal(false)
  })

  it('elides old tool results while keeping the most recent verbatim', function () {
    const result = applyBudget({ system: 'sys', messages: conversation(6), limits })

    const toolMessages = result.messages.filter(message => message.role === 'tool')
    const intact = toolMessages.filter(message => message.content === BIG)
    expect(intact).to.have.length(KEEP_RECENT_TOOL_RESULTS)
    expect(result.elided).to.be.greaterThan(0)
  })

  it('names the tool and how to get the content back in the stub', function () {
    const result = applyBudget({ system: 'sys', messages: conversation(6), limits })
    const stub = result.messages.find(
      message => message.role === 'tool' && message.content !== BIG
    )
    const parsed = JSON.parse((stub as { content: string }).content)
    expect(parsed.elided).to.equal(true)
    expect(parsed.summary).to.include('read_file')
  })

  it('elides oldest first', function () {
    const result = applyBudget({ system: 'sys', messages: conversation(6), limits })
    const toolMessages = result.messages.filter(message => message.role === 'tool')
    const firstIntact = toolMessages.findIndex(message => message.content === BIG)
    expect(firstIntact).to.equal(toolMessages.length - KEEP_RECENT_TOOL_RESULTS)
  })

  it('never orphans a tool call from its result', function () {
    const result = applyBudget({ system: 'sys', messages: conversation(6), limits })
    const callIds = result.messages
      .filter(message => message.role === 'assistant')
      .flatMap(message => (message as { toolCalls?: { id: string }[] }).toolCalls ?? [])
      .map(call => call.id)
    const resultIds = result.messages
      .filter(message => message.role === 'tool')
      .map(message => (message as { toolCallId: string }).toolCallId)
    expect(resultIds.sort()).to.deep.equal(callIds.sort())
  })

  it('never elides user messages', function () {
    const result = applyBudget({ system: 'sys', messages: conversation(6), limits })
    const users = result.messages.filter(message => message.role === 'user')
    expect(users).to.have.length(7)
    expect(users[users.length - 1].content).to.equal('the newest question')
  })

  it('is monotonic — eliding an already-elided array changes nothing', function () {
    const once = applyBudget({ system: 'sys', messages: conversation(6), limits })
    const twice = applyBudget({ system: 'sys', messages: once.messages, limits })
    expect(twice.messages).to.deep.equal(once.messages)
  })

  it('reports exhaustion rather than sending a request that will 400', function () {
    const tiny = { contextWindow: 200, maxOutputTokens: 100 }
    const result = applyBudget({ system: 'sys', messages: conversation(6), limits: tiny })
    expect(result.exhausted).to.equal(true)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/budget.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/context/budget'`.

- [x] **Step 3: Write the budget module**

Create `agent/context/budget.ts`:

```ts
import { AgentMessage } from '../../providers/types'
import { Limits } from './types'

/**
 * Conservative for LaTeX, which tokenises worse than prose because of
 * backslashes and braces. A real tokenizer is not worth shipping to the
 * browser: the three providers do not share one.
 */
export const CHARS_PER_TOKEN = 3.7

/** Absorbs the gap between this estimate and the provider's real count. */
export const MARGIN_FRACTION = 0.1

/** How many of the newest tool results always survive intact. */
export const KEEP_RECENT_TOOL_RESULTS = 3

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function messageTokens(message: AgentMessage): number {
  const content = estimateTokens(message.content ?? '')
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return content + estimateTokens(JSON.stringify(message.toolCalls))
  }
  return content
}

export function estimateRequestTokens(
  system: string,
  messages: AgentMessage[]
): number {
  return (
    estimateTokens(system) +
    messages.reduce((total, message) => total + messageTokens(message), 0)
  )
}

function isElided(message: AgentMessage): boolean {
  if (message.role !== 'tool') return false
  try {
    return JSON.parse(message.content)?.elided === true
  } catch {
    return false
  }
}

function stub(message: Extract<AgentMessage, { role: 'tool' }>): AgentMessage {
  return {
    ...message,
    content: JSON.stringify({
      elided: true,
      summary: `${message.name} result — content elided to fit the context window. Call ${message.name} again if you need it.`,
    }),
  }
}

/**
 * Trims a conversation to fit, deterministically.
 *
 * Order matters and is fixed: stale tool results first, then old assistant
 * text, then give up. Elision is monotonic — an elided result is already at its
 * smallest, so re-running this leaves it alone and the cache prefix restabilises
 * after the one turn where trimming happened.
 */
export function applyBudget({
  system,
  messages,
  limits,
}: {
  system: string
  messages: AgentMessage[]
  limits: Limits
}): { messages: AgentMessage[]; elided: number; exhausted: boolean } {
  const budget =
    limits.contextWindow -
    limits.maxOutputTokens -
    Math.ceil(limits.contextWindow * MARGIN_FRACTION)

  const working = [...messages]
  let elided = 0

  const fits = () => estimateRequestTokens(system, working) <= budget
  if (fits()) return { messages: working, elided: 0, exhausted: false }

  // Pass one: tool results, oldest first, keeping the newest few intact.
  const toolIndexes = working
    .map((message, index) => ({ message, index }))
    .filter(entry => entry.message.role === 'tool')
    .map(entry => entry.index)

  const elidable = toolIndexes.slice(
    0,
    Math.max(0, toolIndexes.length - KEEP_RECENT_TOOL_RESULTS)
  )

  for (const index of elidable) {
    const message = working[index]
    if (isElided(message)) continue
    working[index] = stub(message as Extract<AgentMessage, { role: 'tool' }>)
    elided += 1
    if (fits()) return { messages: working, elided, exhausted: false }
  }

  // Pass two: assistant prose from the oldest turns. Tool calls stay, or the
  // matching results would be orphaned and every provider rejects that.
  for (let index = 0; index < working.length; index++) {
    const message = working[index]
    if (message.role !== 'assistant' || !message.content) continue
    working[index] = { ...message, content: '' }
    if (fits()) return { messages: working, elided, exhausted: false }
  }

  return { messages: working, elided, exhausted: true }
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/budget.test.ts
```

Expected: PASS, 9 passing.

- [x] **Step 5: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

Expected: one new source file, one new test file, untracked.

---
### Task 6: Request assembly and prefix stability

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/agent-messages.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/build-request.ts`
- Test: `modules/ai-assist/test/frontend/js/context/build-request.test.ts`

**Interfaces:**
- Consumes: `SYSTEM_PROMPT` (Task 1), `CacheHints`/`Limits`/`EnvelopeState`/`Attachment` (Task 2), `applyBudget` (Task 5).
- Produces:
  - `TranscriptEntry`'s user variant gains `contextText?: string`, `envelopeState?: EnvelopeState`, `attachments?: Attachment[]`, and loses `selection`.
  - `buildRequest({ transcript, limits, cacheKey }): { system: string; messages: AgentMessage[]; cacheHints: CacheHints; exhausted: boolean }`

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/context/build-request.test.ts`:

```ts
import { expect } from 'chai'
import { buildRequest } from '../../../../frontend/js/features/ai-assist/agent/context/build-request'
import { SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/system-prompt'
import type { TranscriptEntry } from '../../../../frontend/js/features/ai-assist/agent/agent-messages'

const limits = { contextWindow: 128000, maxOutputTokens: 8192 }

const turnOne: TranscriptEntry[] = [
  {
    id: 'u1',
    role: 'user',
    text: 'why does this not build?',
    contextText: '<project-context turn="1">\n<files>main.tex</files>\n</project-context>',
  },
]

const turnTwo: TranscriptEntry[] = [
  ...turnOne,
  {
    id: 'a1',
    role: 'assistant',
    text: 'Let me look.',
    toolCalls: [
      { id: 'c1', name: 'read_file', args: { path: 'main.tex' }, result: { content: '1: hi' } },
    ],
  },
  {
    id: 'u2',
    role: 'user',
    text: 'and now?',
    contextText: '<project-context turn="2">\n<files>unchanged since turn 1</files>\n</project-context>',
  },
]

describe('buildRequest', function () {
  it('uses the constant system prompt verbatim', function () {
    const { system } = buildRequest({ transcript: turnOne, limits })
    expect(system).to.equal(SYSTEM_PROMPT)
  })

  it('prefixes the frozen envelope onto the user message', function () {
    const { messages } = buildRequest({ transcript: turnOne, limits })
    expect(messages[0].role).to.equal('user')
    expect(messages[0].content).to.equal(
      '<project-context turn="1">\n<files>main.tex</files>\n</project-context>\n\nwhy does this not build?'
    )
  })

  it('sends the user text alone when an entry has no envelope', function () {
    const bare: TranscriptEntry[] = [{ id: 'u1', role: 'user', text: 'hello' }]
    const { messages } = buildRequest({ transcript: bare, limits })
    expect(messages[0].content).to.equal('hello')
  })

  // The regression test that protects the entire caching design.
  it('builds turn 2 as a byte-exact extension of turn 1', function () {
    const first = buildRequest({ transcript: turnOne, limits })
    const second = buildRequest({ transcript: turnTwo, limits })

    expect(second.system).to.equal(first.system)
    const prefix = second.messages.slice(0, first.messages.length)
    expect(JSON.stringify(prefix)).to.equal(JSON.stringify(first.messages))
  })

  it('replays tool calls and their results in order', function () {
    const { messages } = buildRequest({ transcript: turnTwo, limits })
    const roles = messages.map(message => message.role)
    expect(roles).to.deep.equal(['user', 'assistant', 'tool', 'user'])
  })

  it('marks the system prompt and tools as cacheable', function () {
    const { cacheHints } = buildRequest({ transcript: turnTwo, limits })
    expect(cacheHints.cacheSystem).to.equal(true)
    expect(cacheHints.cacheTools).to.equal(true)
  })

  it('places the stable breakpoint just before the newest user turn', function () {
    const { messages, cacheHints } = buildRequest({ transcript: turnTwo, limits })
    expect(cacheHints.lastStableMessage).to.equal(messages.length - 2)
  })

  it('has no stable breakpoint on the very first turn', function () {
    const { cacheHints } = buildRequest({ transcript: turnOne, limits })
    expect(cacheHints.lastStableMessage).to.equal(null)
  })

  it('passes a cache key through when given one', function () {
    const { cacheHints } = buildRequest({
      transcript: turnOne,
      limits,
      cacheKey: 'project-abc',
    })
    expect(cacheHints.cacheKey).to.equal('project-abc')
  })

  it('reports exhaustion from the budget pass', function () {
    const { exhausted } = buildRequest({
      transcript: turnTwo,
      limits: { contextWindow: 100, maxOutputTokens: 50 },
    })
    expect(exhausted).to.equal(true)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/build-request.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/context/build-request'`.

- [x] **Step 3: Move the envelope onto the transcript entry**

In `agent/agent-messages.ts`, import the new types and change the user variant of `TranscriptEntry`:

```ts
import { Attachment, EnvelopeState } from './context/types'
```

```ts
export type TranscriptEntry =
  | {
      id: string
      role: 'user'
      text: string
      /** The <project-context> block, rendered at send time and then frozen. */
      contextText?: string
      /** Carried forward so the next turn can delta-encode against it. */
      envelopeState?: EnvelopeState
      /** What the user pinned to this turn; the panel renders chips from it. */
      attachments?: Attachment[]
    }
  | {
      id: string
      role: 'assistant'
      text: string
      thinking?: string
      thinkingElapsedMs?: number
      toolCalls: ToolCallRecord[]
      blocks?: AssistantBlock[]
    }
```

The `selection` field is gone. Replace the user branch of `toAgentMessages` — the old code built a `[Referencing …]` preamble, which duplicated what the system prompt was already saying:

```ts
    if (entry.role === 'user') {
      const content = entry.contextText
        ? `${entry.contextText}\n\n${entry.text}`
        : entry.text
      messages.push({ role: 'user', content })
      return
    }
```

- [x] **Step 4: Write the orchestrator**

Create `agent/context/build-request.ts`:

```ts
import { AgentMessage } from '../../providers/types'
import { TranscriptEntry, toAgentMessages } from '../agent-messages'
import { applyBudget } from './budget'
import { SYSTEM_PROMPT } from './system-prompt'
import { CacheHints, Limits } from './types'

/**
 * Assembles the whole provider request from the transcript.
 *
 * It renders nothing. Envelopes were frozen onto their user entries at send
 * time, so this function only concatenates, trims, and marks cache
 * breakpoints — which is what makes turn N+1 a byte-exact extension of turn N.
 */
export function buildRequest({
  transcript,
  limits,
  cacheKey,
}: {
  transcript: TranscriptEntry[]
  limits: Limits
  cacheKey?: string
}): {
  system: string
  messages: AgentMessage[]
  cacheHints: CacheHints
  exhausted: boolean
} {
  const system = SYSTEM_PROMPT
  const { messages, exhausted } = applyBudget({
    system,
    messages: toAgentMessages(transcript),
    limits,
  })

  // Everything before the newest user turn was settled on a previous request,
  // so it is exactly the prefix worth caching.
  const newestUser = messages.map(message => message.role).lastIndexOf('user')
  const lastStableMessage = newestUser > 0 ? newestUser - 1 : null

  return {
    system,
    messages,
    cacheHints: {
      cacheSystem: true,
      cacheTools: true,
      lastStableMessage,
      cacheKey,
    },
    exhausted,
  }
}
```

- [x] **Step 5: Run test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/build-request.test.ts
```

Expected: PASS, 10 passing.

- [x] **Step 6: Repair the existing agent-messages test**

`test/frontend/js/agent/agent-messages.test.ts` asserts the removed `selection` preamble. Replace those assertions with the `contextText` behaviour:

```ts
  it('prefixes the frozen context block onto the user turn', function () {
    const messages = toAgentMessages([
      { id: 'u1', role: 'user', text: 'fix it', contextText: '<project-context turn="1"></project-context>' },
    ])
    expect(messages[0].content).to.equal(
      '<project-context turn="1"></project-context>\n\nfix it'
    )
  })
```

Delete any test asserting a `[Referencing …]` string; that behaviour is gone on purpose.

- [x] **Step 7: Run the agent-messages test**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/agent-messages.test.ts
```

Expected: PASS.

- [x] **Step 8: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

---

### Task 7: Per-provider limits and settings

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/providers/types.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/provider-form.tsx`
- Test: `modules/ai-assist/test/frontend/js/limits.test.ts`
- Test: `modules/ai-assist/test/frontend/js/components/provider-form.test.tsx` (extend)

**Interfaces:**
- Consumes: `ProviderType`, `ProviderSettings` from `providers/types`.
- Produces:
  - `ProviderSettings` gains `contextWindow?: number` and `maxOutputTokens?: number`.
  - `DEFAULT_LIMITS: Record<ProviderType, Limits>`
  - `resolveLimits(settings: ProviderSettings): Limits`

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/limits.test.ts`:

```ts
import { expect } from 'chai'
import {
  DEFAULT_LIMITS,
  resolveLimits,
} from '../../../frontend/js/features/ai-assist/providers/types'

describe('resolveLimits', function () {
  it('falls back to the provider default', function () {
    const limits = resolveLimits({
      type: 'anthropic',
      baseUrl: '',
      apiKey: '',
      model: 'claude-opus-5',
    })
    expect(limits).to.deep.equal(DEFAULT_LIMITS.anthropic)
  })

  it('gives ollama a smaller output default than the hosted providers', function () {
    expect(DEFAULT_LIMITS.ollama.maxOutputTokens).to.be.lessThan(
      DEFAULT_LIMITS.anthropic.maxOutputTokens
    )
  })

  it('prefers explicit settings over the default', function () {
    const limits = resolveLimits({
      type: 'ollama',
      baseUrl: '',
      apiKey: '',
      model: 'qwen3',
      contextWindow: 32000,
      maxOutputTokens: 2048,
    })
    expect(limits).to.deep.equal({ contextWindow: 32000, maxOutputTokens: 2048 })
  })

  it('ignores nonsense values rather than sending a request that cannot work', function () {
    const limits = resolveLimits({
      type: 'openai',
      baseUrl: '',
      apiKey: '',
      model: 'gpt-4o',
      contextWindow: 0,
      maxOutputTokens: -5,
    })
    expect(limits).to.deep.equal(DEFAULT_LIMITS.openai)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/limits.test.ts
```

Expected: FAIL — `resolveLimits is not a function`.

- [x] **Step 3: Add limits to the provider types**

In `providers/types.ts`, extend `ProviderSettings` and add the table and resolver:

```ts
export type ProviderSettings = {
  type: ProviderType
  baseUrl: string
  apiKey: string
  model: string
  modelName?: string
  /**
   * User-supplied on purpose: the window of an arbitrary Ollama model or an
   * OpenAI-compatible endpoint cannot be detected, and guessing silently fails
   * worse than asking.
   */
  contextWindow?: number
  maxOutputTokens?: number
}

export type Limits = {
  contextWindow: number
  maxOutputTokens: number
}

export const DEFAULT_LIMITS: Record<ProviderType, Limits> = {
  openai: { contextWindow: 128000, maxOutputTokens: 8192 },
  anthropic: { contextWindow: 200000, maxOutputTokens: 8192 },
  ollama: { contextWindow: 32000, maxOutputTokens: 4096 },
}

function positive(value: number | undefined, fallback: number) {
  return typeof value === 'number' && value > 0 ? value : fallback
}

export function resolveLimits(settings: ProviderSettings): Limits {
  const defaults = DEFAULT_LIMITS[settings.type]
  return {
    contextWindow: positive(settings.contextWindow, defaults.contextWindow),
    maxOutputTokens: positive(settings.maxOutputTokens, defaults.maxOutputTokens),
  }
}
```

`agent/context/types.ts` already declares its own `Limits` with the same shape. Delete the one in `context/types.ts` and re-export instead, so there is exactly one definition:

```ts
export type { Limits } from '../../providers/types'
```

- [x] **Step 4: Run test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/limits.test.ts
```

Expected: PASS, 4 passing.

- [x] **Step 5: Write the failing form test**

Append to `modules/ai-assist/test/frontend/js/components/provider-form.test.tsx`, following the render helper already used in that file:

```ts
  it('lets the user set a context window and output cap', async function () {
    const onSave = sinon.stub()
    renderForm({ onSave })

    fireEvent.change(screen.getByLabelText(/context window/i), {
      target: { value: '32000' },
    })
    fireEvent.change(screen.getByLabelText(/max output tokens/i), {
      target: { value: '2048' },
    })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(onSave.lastCall.args[0]).to.include({
      contextWindow: 32000,
      maxOutputTokens: 2048,
    })
  })

  it('leaves the fields empty when the provider uses its defaults', function () {
    renderForm({})
    expect((screen.getByLabelText(/context window/i) as HTMLInputElement).value).to.equal('')
  })
```

- [x] **Step 6: Run it to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/components/provider-form.test.tsx
```

Expected: FAIL — unable to find a label matching `/context window/i`.

- [x] **Step 7: Add the inputs**

In `components/provider-form.tsx`, next to the existing model field, add two optional number inputs bound to `contextWindow` and `maxOutputTokens`. Follow the markup of the fields already in the file; use `placeholder` to show the provider default so an empty field reads as "use the default":

```tsx
<div className="ai-assist-form-row">
  <label htmlFor="ai-assist-context-window">
    {t('ai_assist_context_window', 'Context window (tokens)')}
  </label>
  <input
    id="ai-assist-context-window"
    type="number"
    min={1}
    value={contextWindow}
    placeholder={String(DEFAULT_LIMITS[type].contextWindow)}
    onChange={event => setContextWindow(event.target.value)}
  />
</div>
<div className="ai-assist-form-row">
  <label htmlFor="ai-assist-max-output">
    {t('ai_assist_max_output_tokens', 'Max output tokens')}
  </label>
  <input
    id="ai-assist-max-output"
    type="number"
    min={1}
    value={maxOutputTokens}
    placeholder={String(DEFAULT_LIMITS[type].maxOutputTokens)}
    onChange={event => setMaxOutputTokens(event.target.value)}
  />
</div>
```

On save, convert to numbers and omit the keys entirely when the field is blank, so a cleared field falls back to the default rather than storing `0`:

```ts
const numeric = (value: string) => {
  const parsed = Number(value)
  return value.trim() !== '' && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : undefined
}
```

Add `ai_assist_context_window` and `ai_assist_max_output_tokens` to `services/web/locales/en.json`.

- [x] **Step 8: Run the form test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/components/provider-form.test.tsx
```

Expected: PASS, including the two new cases.

- [x] **Step 9: Verify — do not commit**

```bash
git status --short modules/ai-assist services/web/locales/en.json
```

---
### Task 8: Prompt caching in the provider clients

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/providers/types.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/providers/anthropic.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/providers/openai.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/prompt-caching.test.ts`

**Interfaces:**
- Consumes: `CacheHints` from Task 2, `ChatRequest` from `providers/types`.
- Produces: `ChatRequest` gains `cacheHints?: CacheHints`. No new exports.

Anthropic allows at most four `cache_control` breakpoints per request, so placement is explicit rather than sprayed across the array.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/prompt-caching.test.ts`:

```ts
import { expect } from 'chai'
import fetchMock from 'fetch-mock'
import { AnthropicClient } from '../../../../frontend/js/features/ai-assist/providers/anthropic'
import { OpenAiClient } from '../../../../frontend/js/features/ai-assist/providers/openai'

const ANTHROPIC = {
  type: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-5',
}

const OPENAI = {
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
}

const READ_FILE = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

const LIST_FILES = {
  name: 'list_files',
  description: 'List files',
  parameters: { type: 'object', properties: {} },
}

const MESSAGES = [
  { role: 'user' as const, content: 'first question' },
  { role: 'assistant' as const, content: 'first answer' },
  { role: 'user' as const, content: 'second question' },
]

function sse(body: string) {
  return { body, headers: { 'Content-Type': 'text/event-stream' } }
}

async function collect(generator: AsyncGenerator<any>) {
  const chunks = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}

function lastBody() {
  return JSON.parse(fetchMock.callHistory.lastCall()!.options!.body as string)
}

describe('prompt caching', function () {
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  describe('AnthropicClient', function () {
    beforeEach(function () {
      fetchMock.post(
        'https://api.anthropic.com/v1/messages',
        sse('data: {"type":"message_stop"}\n\n')
      )
    })

    it('sends a plain system string when no hints are given', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
        })
      )
      expect(lastBody().system).to.equal('be helpful')
    })

    it('marks the system prompt as an ephemeral cache breakpoint', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          cacheHints: {
            cacheSystem: true,
            cacheTools: false,
            lastStableMessage: null,
          },
        })
      )
      expect(lastBody().system).to.deep.equal([
        {
          type: 'text',
          text: 'be helpful',
          cache_control: { type: 'ephemeral' },
        },
      ])
    })

    it('marks only the last tool spec, because breakpoints are scarce', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          tools: [LIST_FILES, READ_FILE],
          cacheHints: {
            cacheSystem: false,
            cacheTools: true,
            lastStableMessage: null,
          },
        })
      )
      const { tools } = lastBody()
      expect(tools[0].cache_control).to.equal(undefined)
      expect(tools[1].cache_control).to.deep.equal({ type: 'ephemeral' })
    })

    it('marks the last stable message', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          cacheHints: {
            cacheSystem: true,
            cacheTools: false,
            lastStableMessage: 1,
          },
        })
      )
      const { messages } = lastBody()
      const blocks = messages[1].content
      expect(blocks[blocks.length - 1].cache_control).to.deep.equal({
        type: 'ephemeral',
      })
      expect(messages[2].content[0].cache_control).to.equal(undefined)
    })

    it('never sends more than four breakpoints', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          tools: [LIST_FILES, READ_FILE],
          cacheHints: {
            cacheSystem: true,
            cacheTools: true,
            lastStableMessage: 1,
          },
        })
      )
      const count = JSON.stringify(lastBody()).split('"cache_control"').length - 1
      expect(count).to.be.at.most(4)
    })

    it('ignores an out-of-range stable index instead of throwing', async function () {
      await collect(
        new AnthropicClient(ANTHROPIC).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          cacheHints: {
            cacheSystem: false,
            cacheTools: false,
            lastStableMessage: 99,
          },
        })
      )
      expect(JSON.stringify(lastBody())).to.not.include('cache_control')
    })
  })

  describe('OpenAiClient', function () {
    beforeEach(function () {
      fetchMock.post(
        'https://api.openai.com/v1/chat/completions',
        sse('data: [DONE]\n\n')
      )
    })

    it('sends a prompt_cache_key when one is supplied', async function () {
      await collect(
        new OpenAiClient(OPENAI).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          cacheHints: {
            cacheSystem: true,
            cacheTools: true,
            lastStableMessage: 1,
            cacheKey: 'project-abc',
          },
        })
      )
      expect(lastBody().prompt_cache_key).to.equal('project-abc')
    })

    // OpenAI caches prefixes automatically. Sending Anthropic's directives
    // would be rejected as an unknown field.
    it('never sends cache_control', async function () {
      await collect(
        new OpenAiClient(OPENAI).streamChat({
          system: 'be helpful',
          messages: MESSAGES,
          maxTokens: 100,
          cacheHints: {
            cacheSystem: true,
            cacheTools: true,
            lastStableMessage: 1,
          },
        })
      )
      const body = JSON.stringify(lastBody())
      expect(body).to.not.include('cache_control')
      expect(body).to.not.include('prompt_cache_key')
    })
  })
})
```

- [x] **Step 2: Run test to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/prompt-caching.test.ts
```

Expected: FAIL — the system field is still a bare string when hints are given.

- [x] **Step 3: Add the hints to `ChatRequest`**

In `providers/types.ts`:

```ts
export type CacheHints = {
  cacheSystem: boolean
  cacheTools: boolean
  /** Index into `messages` of the last message stable across turns. */
  lastStableMessage: number | null
  /** Stable per-project key for providers with keyed caches. */
  cacheKey?: string
}

export type ChatRequest = {
  system: string
  messages: AgentMessage[]
  maxTokens: number
  tools?: ToolSpec[]
  cacheHints?: CacheHints
  signal?: AbortSignal
}
```

`agent/context/types.ts` declared its own `CacheHints`. Delete it and re-export.
This line **replaces** the `export type { Limits } …` line added in Task 7 Step 3 —
there should be exactly one re-export, covering both:

```ts
export type { CacheHints, Limits } from '../../providers/types'
```

- [x] **Step 4: Place the breakpoints in `AnthropicClient`**

Add `cacheHints` to the destructured `streamChat` parameters, and above the `fetch` call build the three pieces:

```ts
    const ephemeral = { type: 'ephemeral' as const }

    const systemField = cacheHints?.cacheSystem
      ? [{ type: 'text', text: system, cache_control: ephemeral }]
      : system

    const wireTools = tools?.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      // Only the last spec is marked: the tool array is cached as one prefix,
      // and breakpoints are capped at four per request.
      ...(cacheHints?.cacheTools && index === tools.length - 1
        ? { cache_control: ephemeral }
        : {}),
    }))

    const wireMessages = toWireMessages(messages)
    const stable = cacheHints?.lastStableMessage
    if (
      typeof stable === 'number' &&
      stable >= 0 &&
      stable < wireMessages.length
    ) {
      const blocks = wireMessages[stable].content
      if (Array.isArray(blocks) && blocks.length > 0) {
        blocks[blocks.length - 1] = {
          ...blocks[blocks.length - 1],
          cache_control: ephemeral,
        }
      }
    }
```

Then use them in the body:

```ts
        body: JSON.stringify({
          model: this.model,
          stream: true,
          max_tokens: maxTokens,
          system: systemField,
          messages: wireMessages,
          ...(wireTools?.length ? { tools: wireTools } : {}),
        }),
```

If `toWireMessages` returns string content for simple messages, make it always return a content-block array — the Anthropic API accepts both, and a uniform shape is what lets the breakpoint be attached without a special case.

- [x] **Step 5: Add the cache key in `OpenAiClient`**

Add `cacheHints` to the destructured parameters and one field to the body. Send nothing else: prefix caching is automatic, and an unknown field is a 400.

```ts
          ...(cacheHints?.cacheKey
            ? { prompt_cache_key: cacheHints.cacheKey }
            : {}),
```

- [x] **Step 6: Leave `OllamaClient` alone, deliberately**

Add `cacheHints` to its destructured parameters and ignore it, with a comment so the omission reads as a decision rather than an oversight:

```ts
    // Ollama has no cache API. It benefits from the stable prefix anyway,
    // through its own KV reuse, so there is nothing to send.
```

- [x] **Step 7: Run test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/prompt-caching.test.ts
```

Expected: PASS, 8 passing.

- [x] **Step 8: Run the existing provider tests for regressions**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/anthropic-tools.test.ts modules/ai-assist/test/frontend/js/agent/openai-tools.test.ts modules/ai-assist/test/frontend/js/providers.test.ts
```

Expected: PASS. If a test asserted string content on Anthropic wire messages, update it to the block array — that change is intentional.

- [x] **Step 9: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

---

### Task 9: Wire the loop to the new assembly

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/agent-events.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/run-agent.test.ts` (extend)

**Interfaces:**
- Consumes: `buildRequest` (Task 6), `resolveLimits`/`DEFAULT_LIMITS` (Task 7), `renderEnvelope` (Task 4).
- Produces: `runAgent` takes `limits` and `cacheKey` and no longer builds a prompt itself; `MAX_STEPS = 30`; `AgentEvent` gains a `contextExhausted` error code.

This is the task that makes Phase 1 visible. Until it lands, `run-agent.ts` still imports the deleted `agent/system-prompt`.

- [x] **Step 1: Write the failing test**

Append to `modules/ai-assist/test/frontend/js/agent/run-agent.test.ts`:

```ts
  it('sends the frozen envelope rather than rebuilding a system prompt', async function () {
    const client = fakeClient([{ type: 'text', text: 'ok' }])
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })

    await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [
          {
            id: 'u1',
            role: 'user',
            text: 'hi',
            contextText: '<project-context turn="1"></project-context>',
          },
        ],
        limits: { contextWindow: 128000, maxOutputTokens: 8192 },
      })
    )

    const request = client.requests[0]
    expect(request.system).to.include('You are an AI assistant embedded in the Overleaf')
    expect(request.system).to.not.include('project-context')
    expect(request.messages[0].content).to.include('<project-context turn="1">')
  })

  it('passes cache hints through to the provider', async function () {
    const client = fakeClient([{ type: 'text', text: 'ok' }])
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })

    await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [{ id: 'u1', role: 'user', text: 'hi' }],
        limits: { contextWindow: 128000, maxOutputTokens: 8192 },
        cacheKey: 'project-abc',
      })
    )

    expect(client.requests[0].cacheHints?.cacheSystem).to.equal(true)
    expect(client.requests[0].cacheHints?.cacheKey).to.equal('project-abc')
  })

  it('uses the caller-supplied output cap', async function () {
    const client = fakeClient([{ type: 'text', text: 'ok' }])
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })

    await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [{ id: 'u1', role: 'user', text: 'hi' }],
        limits: { contextWindow: 32000, maxOutputTokens: 2048 },
      })
    )

    expect(client.requests[0].maxTokens).to.equal(2048)
  })

  it('stops with contextExhausted instead of sending a doomed request', async function () {
    const client = fakeClient([{ type: 'text', text: 'ok' }])
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'hello' } })

    const events = await collect(
      runAgent({
        client,
        handle,
        tools: {},
        transcript: [
          { id: 'u1', role: 'user', text: 'x'.repeat(200000) },
        ],
        limits: { contextWindow: 1000, maxOutputTokens: 500 },
      })
    )

    expect(events.some(event => event.type === 'error' && event.code === 'contextExhausted')).to.equal(true)
    expect(client.requests).to.have.length(0)
  })
```

If the file's `fakeClient` helper does not already record requests, extend it to push each `ChatRequest` onto a `requests` array before yielding its scripted chunks.

- [x] **Step 2: Run test to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/run-agent.test.ts
```

Expected: FAIL — `Cannot find module '../system-prompt'` from `run-agent.ts`.

- [x] **Step 3: Add the error code**

In `providers/types.ts`, extend `ProviderErrorCode`:

```ts
export type ProviderErrorCode =
  | 'providerAuth'
  | 'providerError'
  | 'modelsUnsupported'
  | 'network'
  | 'aborted'
  | 'contextExhausted'
```

- [x] **Step 4: Rewrite the head of `runAgent`**

Replace the `buildSystemPrompt` block in `agent/run-agent.ts`. Delete the `import { buildSystemPrompt } from './system-prompt'` line and the try/catch that called it, and add:

```ts
import { buildRequest } from './context/build-request'
import { Limits } from '../providers/types'

export const MAX_STEPS = 30
```

Delete the `MAX_OUTPUT_TOKENS` constant. Add `limits` and `cacheKey` to the parameters:

```ts
export async function* runAgent({
  client,
  handle,
  tools,
  transcript,
  limits,
  cacheKey,
  maxSteps = MAX_STEPS,
  signal,
}: {
  client: ProviderClient
  handle: ProjectHandle
  tools: Record<string, AgentTool>
  transcript: TranscriptEntry[]
  limits: Limits
  cacheKey?: string
  maxSteps?: number
  signal?: AbortSignal
}): AsyncGenerator<AgentEvent> {
  const specs = Object.values(tools).map(tool => tool.spec)

  const request = buildRequest({ transcript, limits, cacheKey })

  if (request.exhausted) {
    yield {
      type: 'error',
      code: 'contextExhausted',
      message:
        'This conversation no longer fits in the model context window. Start a new chat to continue.',
    }
    return yield { type: 'turnFinished', reason: 'stop' }
  }

  const system = request.system
  const messages: AgentMessage[] = request.messages
```

In the `client.streamChat({ ... })` call, replace `maxTokens: MAX_OUTPUT_TOKENS` with `maxTokens: limits.maxOutputTokens` and add `cacheHints: request.cacheHints`.

`handle` is still a parameter because tools need it; the loop itself no longer reads the project.

- [x] **Step 5: Run test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/run-agent.test.ts
```

Expected: PASS, including the four new cases.

- [x] **Step 6: Render the envelope at send time in the panel**

In `components/agent/agent-panel.tsx`, at the point where a user entry is appended, build the snapshot and freeze the envelope onto the entry. The previous state comes from the last user entry in the transcript, which is what makes the delta encoding work:

```ts
const previousUser = [...transcript].reverse().find(entry => entry.role === 'user')
const turn = (previousUser?.envelopeState?.turn ?? 0) + 1

const compile = handle.lastCompile()
const snapshot: ContextSnapshot = {
  rootDocPath: handle.rootDocPath(),
  files: await handle.listFiles(),
  openFile: handle.openFile(),
  selection: attachedSelection ?? handle.currentSelection(),
  compile: compile
    ? {
        status: compile.status,
        errorCount: compile.errors.length,
        warningCount: compile.warnings.length,
      }
    : null,
}

const envelope = renderEnvelope({
  snapshot,
  attachments,
  turn,
  previous: previousUser?.envelopeState ?? null,
})

appendUserEntry({
  id,
  role: 'user',
  text,
  contextText: envelope.text,
  envelopeState: envelope.state,
  attachments,
})
```

Wrap the snapshot build in a try/catch. On failure, append the entry with no `contextText` — a snapshot that will not load must not stop the user talking to the model, which is the rule the old code held at `run-agent.ts:41`.

Pass `limits={resolveLimits(settings)}` and `cacheKey={projectId}` into `runAgent`, and handle the `contextExhausted` code by offering "Start a new chat" rather than the generic provider error text.

- [x] **Step 7: Run the whole module suite**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js
```

Expected: all module tests pass. Phase 1 is complete at this point: the agent runs on a constant system prompt, a frozen envelope, real limits, and cache breakpoints.

- [x] **Step 8: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

Expected: a set of modified and untracked files, nothing staged, no new commits.

---
## Phase 2 — Tools

### Task 10: LaTeX outline parser and `outline_project`

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/outline.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/outline-project.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Test: `modules/ai-assist/test/frontend/js/context/outline.test.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/outline-tool.test.ts`

**Interfaces:**
- Consumes: `ProjectHandle` (Tasks 2–3).
- Produces:
  - `parseOutline({ docs, rootPath }): Outline`
  - `readBraceGroup(text: string, openIndex: number): { body: string; end: number } | null`
  - `Outline`, `OutlineSection`, `OutlineInclude`
  - `outlineProjectTool: AgentTool`

- [x] **Step 1: Write the failing parser test**

Create `modules/ai-assist/test/frontend/js/context/outline.test.ts`:

```ts
import { expect } from 'chai'
import {
  parseOutline,
  readBraceGroup,
} from '../../../../frontend/js/features/ai-assist/agent/context/outline'

const MAIN = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath, graphicx}
\\begin{document}
\\section{Introduction}
Some text.
\\input{sections/method}
\\include{sections/results.tex}
\\section*{Unnumbered}
\\subsection{Detail with \\textbf{bold} inside}
\\end{document}`

const METHOD = `\\section{Method}
\\subsection{Setup}`

describe('readBraceGroup', function () {
  it('reads a simple group', function () {
    const result = readBraceGroup('\\section{Hello}', 8)
    expect(result?.body).to.equal('Hello')
  })

  it('reads a group containing nested braces', function () {
    const result = readBraceGroup('\\section{a \\textbf{b} c}', 8)
    expect(result?.body).to.equal('a \\textbf{b} c')
  })

  it('returns null for an unterminated group', function () {
    expect(readBraceGroup('\\section{oops', 8)).to.equal(null)
  })
})

describe('parseOutline', function () {
  const docs = { 'main.tex': MAIN, 'sections/method.tex': METHOD }

  it('reads the document class without its options', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    expect(outline.documentClass).to.equal('article')
  })

  it('collects packages, splitting comma-separated lists', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    expect(outline.packages).to.have.members([
      'inputenc',
      'amsmath',
      'graphicx',
    ])
  })

  it('records sections with file, line and level', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    const intro = outline.sections.find(section => section.title === 'Introduction')
    expect(intro).to.deep.include({ path: 'main.tex', line: 5, level: 1 })
  })

  it('keeps nested braces in a title', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    const titles = outline.sections.map(section => section.title)
    expect(titles).to.include('Detail with \\textbf{bold} inside')
  })

  it('marks starred sections as unnumbered', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    const starred = outline.sections.find(section => section.title === 'Unnumbered')
    expect(starred?.numbered).to.equal(false)
  })

  it('levels subsections below sections', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    const section = outline.sections.find(entry => entry.title === 'Introduction')
    const subsection = outline.sections.find(entry => entry.title.startsWith('Detail'))
    expect(subsection!.level).to.be.greaterThan(section!.level)
  })

  it('resolves \\input and \\include, adding the .tex extension', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    expect(outline.includes).to.deep.include({
      from: 'main.tex',
      to: 'sections/method.tex',
      line: 7,
      resolved: true,
    })
    expect(outline.includes).to.deep.include({
      from: 'main.tex',
      to: 'sections/results.tex',
      line: 8,
      resolved: false,
    })
  })

  it('includes sections from included files', function () {
    const outline = parseOutline({ docs, rootPath: 'main.tex' })
    const method = outline.sections.find(section => section.title === 'Method')
    expect(method?.path).to.equal('sections/method.tex')
  })

  it('ignores commented-out commands', function () {
    const outline = parseOutline({
      docs: { 'main.tex': '% \\section{Hidden}\n\\section{Shown}' },
      rootPath: 'main.tex',
    })
    expect(outline.sections.map(section => section.title)).to.deep.equal(['Shown'])
  })

  it('survives a malformed file and says so', function () {
    const outline = parseOutline({
      docs: { 'main.tex': '\\section{Unterminated' },
      rootPath: 'main.tex',
    })
    expect(outline.sections).to.deep.equal([])
    expect(outline.notes.join(' ')).to.match(/could not be parsed|unterminated/i)
  })

  it('works with no root document set', function () {
    const outline = parseOutline({ docs, rootPath: null })
    expect(outline.sections.length).to.be.greaterThan(0)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/outline.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/context/outline'`.

- [x] **Step 3: Write the parser**

Create `agent/context/outline.ts`:

```ts
export type OutlineSection = {
  path: string
  line: number
  level: number
  title: string
  numbered: boolean
}

export type OutlineInclude = {
  from: string
  to: string
  line: number
  resolved: boolean
}

export type Outline = {
  documentClass: string | null
  packages: string[]
  sections: OutlineSection[]
  includes: OutlineInclude[]
  notes: string[]
}

const LEVELS: Record<string, number> = {
  part: -1,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
}

const SECTION_RE =
  /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{/
const INPUT_RE = /\\(?:input|include)\s*\{/
const CLASS_RE = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/
const PACKAGE_RE = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g

/** Strips a line comment, respecting an escaped percent sign. */
function uncomment(line: string): string {
  const index = line.search(/(?<!\\)%/)
  return index === -1 ? line : line.slice(0, index)
}

/**
 * Reads a brace group starting at `openIndex`, honouring nesting.
 *
 * A regex cannot do this: section titles routinely contain \textbf{...}, and a
 * lazy [^}]* would cut the title in half.
 */
export function readBraceGroup(
  text: string,
  openIndex: number
): { body: string; end: number } | null {
  if (text[openIndex] !== '{') return null
  let depth = 0
  for (let index = openIndex; index < text.length; index++) {
    const char = text[index]
    if (char === '{' && text[index - 1] !== '\\') depth += 1
    else if (char === '}' && text[index - 1] !== '\\') {
      depth -= 1
      if (depth === 0) {
        return { body: text.slice(openIndex + 1, index), end: index }
      }
    }
  }
  return null
}

function resolveInclude(target: string, docs: Record<string, string>) {
  const candidates = [target, `${target}.tex`, target.replace(/\.tex$/, '')]
  const hit = candidates.find(candidate => candidate in docs)
  return hit ?? (target.endsWith('.tex') ? target : `${target}.tex`)
}

/**
 * Parses project structure without reading whole files into the model.
 *
 * Never throws: a partial outline of a malformed project is more useful to the
 * agent than an error, so problems are reported in `notes`.
 */
export function parseOutline({
  docs,
  rootPath,
}: {
  docs: Record<string, string>
  rootPath: string | null
}): Outline {
  const sections: OutlineSection[] = []
  const includes: OutlineInclude[] = []
  const packages: string[] = []
  const notes: string[] = []
  let documentClass: string | null = null

  const order = rootPath && rootPath in docs
    ? [rootPath, ...Object.keys(docs).filter(path => path !== rootPath)]
    : Object.keys(docs)

  for (const path of order) {
    if (!path.endsWith('.tex')) continue
    const lines = docs[path].split('\n')

    lines.forEach((rawLine, index) => {
      const line = uncomment(rawLine)
      const lineNumber = index + 1

      if (!documentClass) {
        const found = line.match(CLASS_RE)
        if (found) documentClass = found[1].trim()
      }

      PACKAGE_RE.lastIndex = 0
      let pkg = PACKAGE_RE.exec(line)
      while (pkg) {
        for (const name of pkg[1].split(',')) {
          const trimmed = name.trim()
          if (trimmed && !packages.includes(trimmed)) packages.push(trimmed)
        }
        pkg = PACKAGE_RE.exec(line)
      }

      const section = line.match(SECTION_RE)
      if (section && section.index !== undefined) {
        const open = section.index + section[0].length - 1
        const group = readBraceGroup(line, open)
        if (!group) {
          notes.push(`${path}:${lineNumber}: unterminated section title, skipped`)
        } else {
          sections.push({
            path,
            line: lineNumber,
            level: LEVELS[section[1]],
            title: group.body.trim(),
            numbered: section[2] !== '*',
          })
        }
      }

      const include = line.match(INPUT_RE)
      if (include && include.index !== undefined) {
        const open = include.index + include[0].length - 1
        const group = readBraceGroup(line, open)
        if (!group) {
          notes.push(`${path}:${lineNumber}: unterminated \\input, skipped`)
        } else {
          const target = resolveInclude(group.body.trim(), docs)
          includes.push({
            from: path,
            to: target,
            line: lineNumber,
            resolved: target in docs,
          })
        }
      }
    })
  }

  return { documentClass, packages, sections, includes, notes }
}
```

- [x] **Step 4: Run the parser test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/outline.test.ts
```

Expected: PASS, 15 passing.

- [x] **Step 5: Write the failing tool test**

Create `modules/ai-assist/test/frontend/js/agent/outline-tool.test.ts`:

```ts
import { expect } from 'chai'
import { outlineProjectTool } from '../../../../frontend/js/features/ai-assist/agent/tools/outline-project'
import { createFakeHandle } from './helpers/fake-handle'

const DOCS = {
  'main.tex': '\\documentclass{article}\n\\section{Intro}\n\\input{body}',
  'body.tex': '\\section{Body}',
}

describe('outline_project', function () {
  it('describes itself so a model knows when to reach for it', function () {
    expect(outlineProjectTool.spec.name).to.equal('outline_project')
    expect(outlineProjectTool.spec.description.toLowerCase()).to.include('structure')
  })

  it('does not suspend the loop', function () {
    expect(outlineProjectTool.suspends).to.equal(false)
  })

  it('returns the class, sections and include graph', async function () {
    const { handle } = createFakeHandle({ docs: DOCS, rootDoc: 'main.tex' })
    const result: any = await outlineProjectTool.execute({}, handle)

    expect(result.documentClass).to.equal('article')
    expect(result.sections).to.have.length(2)
    expect(result.includes[0]).to.include({ to: 'body.tex', resolved: true })
  })

  it('narrows to one file when given a path', async function () {
    const { handle } = createFakeHandle({ docs: DOCS, rootDoc: 'main.tex' })
    const result: any = await outlineProjectTool.execute({ path: 'body.tex' }, handle)

    expect(result.sections).to.have.length(1)
    expect(result.sections[0].title).to.equal('Body')
  })

  it('errors clearly for a path that is not in the project', async function () {
    const { handle } = createFakeHandle({ docs: DOCS, rootDoc: 'main.tex' })
    const result: any = await outlineProjectTool.execute({ path: 'nope.tex' }, handle)
    expect(result.error).to.include('nope.tex')
  })

  it('skips binaries rather than trying to parse them', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      binaries: ['figure.pdf'],
      rootDoc: 'main.tex',
    })
    const result: any = await outlineProjectTool.execute({}, handle)
    expect(JSON.stringify(result)).to.not.include('figure.pdf')
  })
})
```

- [x] **Step 6: Run it to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/outline-tool.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/tools/outline-project'`.

- [x] **Step 7: Write the tool**

Create `agent/tools/outline-project.ts`:

```ts
import { AgentTool } from './registry'
import { parseOutline } from '../context/outline'

export const outlineProjectTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'outline_project',
    description:
      'Get the structure of the project: section headings with line numbers, the \\input/\\include graph, the document class and loaded packages. Use this to orient yourself before reading files — it is far cheaper than reading them.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Outline only this file instead of the whole project',
        },
      },
      required: [],
    },
  },

  async execute({ path }, handle) {
    const files = await handle.listFiles()

    if (path) {
      const file = files.find(candidate => candidate.path === path)
      if (!file) return { error: `File not found: ${path}` }
      if (file.type === 'binary') {
        return { error: `${path} is a binary file and has no outline.` }
      }
      const { lines } = await handle.readFile(path)
      return parseOutline({ docs: { [path]: lines.join('\n') }, rootPath: path })
    }

    const docs: Record<string, string> = {}
    for (const file of files) {
      if (file.type !== 'doc' || !file.path.endsWith('.tex')) continue
      const { lines } = await handle.readFile(file.path)
      docs[file.path] = lines.join('\n')
    }

    return parseOutline({ docs, rootPath: handle.rootDocPath() })
  },
}
```

- [x] **Step 8: Register it**

In `agent/tools/registry.ts`, import `outlineProjectTool` and add `outline_project: outlineProjectTool` to `TOOLS`.

- [x] **Step 9: Run the tool test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/outline-tool.test.ts
```

Expected: PASS, 5 passing.

- [x] **Step 10: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

---
### Task 11: Reference extraction and `list_references`

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/references.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/list-references.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Test: `modules/ai-assist/test/frontend/js/context/references.test.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/references-tool.test.ts`

**Interfaces:**
- Consumes: `uncomment`-style line handling from Task 10 (re-implemented locally; `outline.ts` does not export it).
- Produces:
  - `extractReferences({ docs }): References`
  - `References`, `ReferenceUse`, `LabelDefinition`
  - `listReferencesTool: AgentTool`

- [x] **Step 1: Write the failing extractor test**

Create `modules/ai-assist/test/frontend/js/context/references.test.ts`:

```ts
import { expect } from 'chai'
import { extractReferences } from '../../../../frontend/js/features/ai-assist/agent/context/references'

const MAIN = `\\section{Intro}\\label{sec:intro}
See \\ref{sec:intro} and \\ref{sec:missing}.
Also \\eqref{eq:one} and \\autoref{sec:intro}.
\\cite{knuth1984,lamport1994}
\\citep{missingkey}
% \\label{sec:commented}
\\section{Dup}\\label{sec:intro}`

const BIB = `@book{knuth1984,
  title = {The TeXbook}
}
@article{lamport1994,
  title = {LaTeX}
}`

describe('extractReferences', function () {
  const docs = { 'main.tex': MAIN, 'refs.bib': BIB }

  it('finds label definitions with file and line', function () {
    const refs = extractReferences({ docs })
    expect(refs.labels[0]).to.deep.include({
      key: 'sec:intro',
      path: 'main.tex',
      line: 1,
    })
  })

  it('collects bib keys from .bib files', function () {
    const refs = extractReferences({ docs })
    expect(refs.bibKeys.map(entry => entry.key)).to.have.members([
      'knuth1984',
      'lamport1994',
    ])
  })

  it('resolves a reference that has a matching label', function () {
    const refs = extractReferences({ docs })
    const hit = refs.refs.find(entry => entry.key === 'sec:intro')
    expect(hit?.resolved).to.equal(true)
  })

  it('flags a reference with no label', function () {
    const refs = extractReferences({ docs })
    const miss = refs.refs.find(entry => entry.key === 'sec:missing')
    expect(miss?.resolved).to.equal(false)
  })

  it('treats \\eqref and \\autoref as references', function () {
    const refs = extractReferences({ docs })
    const keys = refs.refs.map(entry => entry.key)
    expect(keys).to.include('eq:one')
    expect(keys.filter(key => key === 'sec:intro')).to.have.length(2)
  })

  it('splits a multi-key \\cite', function () {
    const refs = extractReferences({ docs })
    const keys = refs.citations.map(entry => entry.key)
    expect(keys).to.include('knuth1984')
    expect(keys).to.include('lamport1994')
  })

  it('resolves citations against the bib keys', function () {
    const refs = extractReferences({ docs })
    expect(refs.citations.find(entry => entry.key === 'knuth1984')?.resolved).to.equal(true)
    expect(refs.citations.find(entry => entry.key === 'missingkey')?.resolved).to.equal(false)
  })

  it('treats \\citep as a citation', function () {
    const refs = extractReferences({ docs })
    expect(refs.citations.map(entry => entry.key)).to.include('missingkey')
  })

  it('ignores commented-out labels', function () {
    const refs = extractReferences({ docs })
    expect(refs.labels.map(entry => entry.key)).to.not.include('sec:commented')
  })

  it('reports a duplicate label', function () {
    const refs = extractReferences({ docs })
    expect(refs.duplicateLabels).to.deep.equal(['sec:intro'])
  })

  it('returns empty collections for an empty project', function () {
    const refs = extractReferences({ docs: {} })
    expect(refs.labels).to.deep.equal([])
    expect(refs.citations).to.deep.equal([])
    expect(refs.duplicateLabels).to.deep.equal([])
  })
})
```

- [x] **Step 2: Run it to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/references.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/context/references'`.

- [x] **Step 3: Write the extractor**

Create `agent/context/references.ts`:

```ts
export type LabelDefinition = { key: string; path: string; line: number }
export type ReferenceUse = {
  key: string
  path: string
  line: number
  command: string
  resolved: boolean
}

export type References = {
  labels: LabelDefinition[]
  refs: ReferenceUse[]
  citations: ReferenceUse[]
  bibKeys: LabelDefinition[]
  duplicateLabels: string[]
}

const LABEL_RE = /\\label\s*\{([^}]*)\}/g
const REF_RE = /\\(ref|eqref|autoref|cref|Cref|pageref)\s*\{([^}]*)\}/g
const CITE_RE =
  /\\(cite|citep|citet|citeauthor|citeyear|nocite)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
const BIB_ENTRY_RE = /^\s*@\w+\s*\{\s*([^,\s}]+)\s*,/

function uncomment(line: string): string {
  const index = line.search(/(?<!\\)%/)
  return index === -1 ? line : line.slice(0, index)
}

function keysOf(group: string): string[] {
  return group
    .split(',')
    .map(key => key.trim())
    .filter(Boolean)
}

/**
 * Finds every label, reference and citation, with whether it resolves.
 *
 * Undefined references and missing citations are the most common LaTeX
 * failure, and this answers them without reading a single file into the model's
 * context.
 */
export function extractReferences({
  docs,
}: {
  docs: Record<string, string>
}): References {
  const labels: LabelDefinition[] = []
  const bibKeys: LabelDefinition[] = []
  const rawRefs: Omit<ReferenceUse, 'resolved'>[] = []
  const rawCitations: Omit<ReferenceUse, 'resolved'>[] = []

  for (const [path, contents] of Object.entries(docs)) {
    const isBib = path.endsWith('.bib')

    contents.split('\n').forEach((rawLine, index) => {
      const line = isBib ? rawLine : uncomment(rawLine)
      const lineNumber = index + 1

      if (isBib) {
        const entry = line.match(BIB_ENTRY_RE)
        if (entry) bibKeys.push({ key: entry[1], path, line: lineNumber })
        return
      }

      LABEL_RE.lastIndex = 0
      let label = LABEL_RE.exec(line)
      while (label) {
        for (const key of keysOf(label[1])) {
          labels.push({ key, path, line: lineNumber })
        }
        label = LABEL_RE.exec(line)
      }

      REF_RE.lastIndex = 0
      let ref = REF_RE.exec(line)
      while (ref) {
        for (const key of keysOf(ref[2])) {
          rawRefs.push({ key, path, line: lineNumber, command: ref[1] })
        }
        ref = REF_RE.exec(line)
      }

      CITE_RE.lastIndex = 0
      let cite = CITE_RE.exec(line)
      while (cite) {
        for (const key of keysOf(cite[2])) {
          rawCitations.push({ key, path, line: lineNumber, command: cite[1] })
        }
        cite = CITE_RE.exec(line)
      }
    })
  }

  const labelKeys = new Set(labels.map(label => label.key))
  const bibKeySet = new Set(bibKeys.map(entry => entry.key))

  const seen = new Set<string>()
  const duplicateLabels: string[] = []
  for (const label of labels) {
    if (seen.has(label.key) && !duplicateLabels.includes(label.key)) {
      duplicateLabels.push(label.key)
    }
    seen.add(label.key)
  }

  return {
    labels,
    bibKeys,
    duplicateLabels,
    refs: rawRefs.map(use => ({ ...use, resolved: labelKeys.has(use.key) })),
    citations: rawCitations.map(use => ({
      ...use,
      resolved: bibKeySet.has(use.key),
    })),
  }
}
```

- [x] **Step 4: Run the extractor test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/references.test.ts
```

Expected: PASS, 11 passing.

- [x] **Step 5: Write the failing tool test**

Create `modules/ai-assist/test/frontend/js/agent/references-tool.test.ts`:

```ts
import { expect } from 'chai'
import { listReferencesTool } from '../../../../frontend/js/features/ai-assist/agent/tools/list-references'
import { createFakeHandle } from './helpers/fake-handle'

const DOCS = {
  'main.tex': '\\label{a}\n\\ref{a}\n\\ref{gone}\n\\cite{book}\n\\cite{nobook}',
  'refs.bib': '@book{book,\n title={T}\n}',
}

describe('list_references', function () {
  it('describes itself in terms of the failure it prevents', function () {
    expect(listReferencesTool.spec.name).to.equal('list_references')
    expect(listReferencesTool.spec.description.toLowerCase()).to.include('undefined')
  })

  it('returns labels, refs, citations and bib keys by default', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await listReferencesTool.execute({}, handle)

    expect(result.labels).to.have.length(1)
    expect(result.refs).to.have.length(2)
    expect(result.citations).to.have.length(2)
    expect(result.bibKeys).to.have.length(1)
  })

  it('narrows to labels when asked', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await listReferencesTool.execute({ kind: 'labels' }, handle)

    expect(result.labels).to.have.length(1)
    expect(result.refs).to.equal(undefined)
    expect(result.citations).to.equal(undefined)
  })

  it('returns only the broken ones with undefinedOnly', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await listReferencesTool.execute({ undefinedOnly: true }, handle)

    expect(result.refs.map((use: any) => use.key)).to.deep.equal(['gone'])
    expect(result.citations.map((use: any) => use.key)).to.deep.equal(['nobook'])
  })

  it('summarises counts so the model can stop early when all is well', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await listReferencesTool.execute({}, handle)
    expect(result.summary).to.include('1 undefined reference')
    expect(result.summary).to.include('1 missing citation')
  })
})
```

- [x] **Step 6: Run it to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/references-tool.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/tools/list-references'`.

- [x] **Step 7: Write the tool**

Create `agent/tools/list-references.ts`:

```ts
import { AgentTool } from './registry'
import { extractReferences } from '../context/references'

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export const listReferencesTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'list_references',
    description:
      'List every \\label, \\ref and \\cite in the project with whether it resolves, plus the keys in every .bib file. Use this for undefined references, missing citations, and duplicate labels instead of reading files.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['labels', 'refs', 'citations', 'all'],
          description: 'Which collection to return. Defaults to all.',
        },
        undefinedOnly: {
          type: 'boolean',
          description: 'Return only references and citations that do not resolve',
        },
      },
      required: [],
    },
  },

  async execute({ kind = 'all', undefinedOnly = false }, handle) {
    const files = await handle.listFiles()
    const docs: Record<string, string> = {}

    for (const file of files) {
      if (file.type !== 'doc') continue
      if (!file.path.endsWith('.tex') && !file.path.endsWith('.bib')) continue
      const { lines } = await handle.readFile(file.path)
      docs[file.path] = lines.join('\n')
    }

    const found = extractReferences({ docs })
    const brokenRefs = found.refs.filter(use => !use.resolved)
    const brokenCitations = found.citations.filter(use => !use.resolved)

    const result: Record<string, unknown> = {
      summary: [
        plural(brokenRefs.length, 'undefined reference'),
        plural(brokenCitations.length, 'missing citation'),
        plural(found.duplicateLabels.length, 'duplicate label'),
      ].join(', '),
      duplicateLabels: found.duplicateLabels,
    }

    if (kind === 'all' || kind === 'labels') {
      result.labels = found.labels
      result.bibKeys = found.bibKeys
    }
    if (kind === 'all' || kind === 'refs') {
      result.refs = undefinedOnly ? brokenRefs : found.refs
    }
    if (kind === 'all' || kind === 'citations') {
      result.citations = undefinedOnly ? brokenCitations : found.citations
    }

    return result
  },
}
```

- [x] **Step 8: Register it**

In `agent/tools/registry.ts`, import `listReferencesTool` and add `list_references: listReferencesTool` to `TOOLS`.

- [x] **Step 9: Run the tool test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/references-tool.test.ts
```

Expected: PASS, 5 passing.

- [x] **Step 10: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

---
### Task 12: Sharper reads, sharper search, cheaper rendering

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/search-project.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts` (extend)
- Test: `modules/ai-assist/test/frontend/js/agent/tool-rendering.test.ts`

**Interfaces:**
- Consumes: `AgentTool` from `tools/registry`.
- Produces:
  - `AgentTool` gains `render?(result: unknown): string`.
  - `read_file` result gains `from`, `to`, `totalLines`, `nextRange`.
  - `search_project` arguments gain `path` and `contextLines`; result gains `total` and per-hit `before`/`after`.
  - `matchesGlob(path: string, pattern: string): boolean` exported from `search-project.ts`.

- [x] **Step 1: Write the failing read tests**

Append to `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts`, adding `MAX_READ_LINES` and `matchesGlob` to its imports:

```ts
  it('reports the total line count so the model can page', async function () {
    const lines = Array.from({ length: 20 }, (_unused, index) => `line ${index + 1}`)
    const { handle } = createFakeHandle({ docs: { 'main.tex': lines.join('\n') } })

    const result: any = await readFileTool.execute({ path: 'main.tex', from: 5, to: 8 }, handle)

    expect(result.totalLines).to.equal(20)
    expect(result.from).to.equal(5)
    expect(result.to).to.equal(8)
    expect(result.content).to.include('5: line 5')
    expect(result.content).to.include('8: line 8')
    expect(result.content).to.not.include('9: line 9')
  })

  it('names the next range to request when it truncates', async function () {
    const lines = Array.from({ length: MAX_READ_LINES + 50 }, (_unused, index) => `l${index}`)
    const { handle } = createFakeHandle({ docs: { 'big.tex': lines.join('\n') } })

    const result: any = await readFileTool.execute({ path: 'big.tex' }, handle)

    expect(result.truncated).to.equal(true)
    expect(result.nextRange).to.deep.equal({
      from: MAX_READ_LINES + 1,
      to: MAX_READ_LINES + 50,
    })
  })

  it('has no next range once the end of the file is reached', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'a\nb\nc' } })
    const result: any = await readFileTool.execute({ path: 'main.tex' }, handle)

    expect(result.truncated).to.equal(false)
    expect(result.nextRange).to.equal(undefined)
  })

  it('clamps a range that runs past the end of the file', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'a\nb\nc' } })
    const result: any = await readFileTool.execute({ path: 'main.tex', from: 2, to: 99 }, handle)

    expect(result.to).to.equal(3)
    expect(result.content).to.include('3: c')
  })

  it('filters hits by a path glob', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': 'needle here',
        'sections/one.tex': 'needle here too',
        'refs.bib': 'needle in bib',
      },
    })

    const result: any = await searchProjectTool.execute(
      { query: 'needle', path: 'sections/*.tex' },
      handle
    )

    expect(result.hits.map((hit: any) => hit.path)).to.deep.equal(['sections/one.tex'])
  })

  it('matches globs with and without directory crossing', function () {
    expect(matchesGlob('a/b/c.tex', '**/*.tex')).to.equal(true)
    expect(matchesGlob('a/b/c.bib', '**/*.tex')).to.equal(false)
    expect(matchesGlob('main.tex', '**/*.tex')).to.equal(true)
    expect(matchesGlob('main.tex', '*.tex')).to.equal(true)
    expect(matchesGlob('a/main.tex', '*.tex')).to.equal(false)
    expect(matchesGlob('sections/one.tex', 'sections/*.tex')).to.equal(true)
  })

  it('returns surrounding context lines', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'before\nneedle\nafter' },
    })

    const result: any = await searchProjectTool.execute(
      { query: 'needle', contextLines: 1 },
      handle
    )

    expect(result.hits[0].before).to.deep.equal(['before'])
    expect(result.hits[0].after).to.deep.equal(['after'])
  })

  it('reports the true total when it truncates', async function () {
    const many = Array.from({ length: 80 }, () => 'needle').join('\n')
    const { handle } = createFakeHandle({ docs: { 'main.tex': many } })

    const result: any = await searchProjectTool.execute({ query: 'needle' }, handle)

    expect(result.truncated).to.equal(true)
    expect(result.total).to.equal(80)
    expect(result.hits.length).to.be.lessThan(80)
  })
```

- [x] **Step 2: Write the failing rendering test**

Create `modules/ai-assist/test/frontend/js/agent/tool-rendering.test.ts`:

```ts
import { expect } from 'chai'
import { readFileTool } from '../../../../frontend/js/features/ai-assist/agent/tools/read-file'
import { listFilesTool } from '../../../../frontend/js/features/ai-assist/agent/tools/list-files'
import { createFakeHandle } from './helpers/fake-handle'

describe('tool result rendering', function () {
  it('renders a read as fenced numbered text, not escaped JSON', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'a\nb' } })
    const result = await readFileTool.execute({ path: 'main.tex' }, handle)
    const rendered = readFileTool.render!(result)

    expect(rendered).to.include('main.tex')
    expect(rendered).to.include('1: a')
    expect(rendered).to.not.include('\\n')
  })

  it('says how to get the rest when a read was truncated', async function () {
    const lines = Array.from({ length: 1500 }, (_unused, index) => `l${index}`)
    const { handle } = createFakeHandle({ docs: { 'big.tex': lines.join('\n') } })
    const result = await readFileTool.execute({ path: 'big.tex' }, handle)

    expect(readFileTool.render!(result)).to.match(/read_file.*1001/)
  })

  it('renders an error result as JSON so the model can branch on it', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'a' } })
    const result = await readFileTool.execute({ path: 'nope.tex' }, handle)

    expect(readFileTool.render!(result)).to.include('"error"')
  })

  it('leaves tools without a renderer alone', function () {
    expect(listFilesTool.render).to.equal(undefined)
  })
})
```

- [x] **Step 3: Run both files to verify they fail**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/read-tools.test.ts modules/ai-assist/test/frontend/js/agent/tool-rendering.test.ts
```

Expected: FAIL — `matchesGlob` is not exported and `readFileTool.render` is undefined.

- [x] **Step 4: Add the renderer hook**

In `agent/tools/registry.ts`:

```ts
export type AgentTool = {
  spec: ToolSpec
  /** True when the tool needs the user before it can finish. */
  suspends: boolean
  execute(args: any, handle: ProjectHandle): Promise<unknown>
  /**
   * Optional plain-text rendering of a result for the model.
   *
   * File content inside JSON is mostly escape sequences. Rendering it as fenced
   * text costs roughly a third fewer tokens and the model quotes it back more
   * accurately. The structured result is still what the transcript stores and
   * what the panel renders.
   */
  render?(result: unknown): string
}
```

- [x] **Step 5: Use it in the loop**

In `agent/run-agent.ts`, where the tool result becomes a message, prefer the renderer:

```ts
      const rendered =
        tool?.render && !isError ? tool.render(result) : JSON.stringify(result)

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: rendered,
        isError,
      })
```

The `toolCallFinished` event keeps carrying the structured `result`, so the panel is untouched.

- [x] **Step 6: Sharpen `read_file`**

Replace `execute` in `agent/tools/read-file.ts` and add a `render`:

```ts
  async execute({ path, from, to }, handle) {
    const files = await handle.listFiles()
    const file = files.find(candidate => candidate.path === path)

    if (!file) return { error: `File not found: ${path}` }
    if (file.type === 'binary') {
      return { error: `${path} is a binary file and cannot be read as text.` }
    }

    // Read the whole file so the total is honest. It is already in the
    // browser's project snapshot, so this costs nothing extra.
    const { lines } = await handle.readFile(path)
    const totalLines = lines.length

    const start = Math.max(1, from ?? 1)
    const requestedEnd = Math.min(to ?? totalLines, totalLines)
    const capped = lines.slice(start - 1, requestedEnd).slice(0, MAX_READ_LINES)
    const end = start + capped.length - 1

    const nextRange =
      end < totalLines
        ? { from: end + 1, to: Math.min(end + MAX_READ_LINES, totalLines) }
        : undefined

    return {
      path,
      from: start,
      to: end,
      totalLines,
      content: number(capped, start),
      truncated: Boolean(nextRange),
      ...(nextRange ? { nextRange } : {}),
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)

    const header = `${result.path} lines ${result.from}-${result.to} of ${result.totalLines}`
    const footer = result.nextRange
      ? `\n(truncated - call read_file with from=${result.nextRange.from}, to=${result.nextRange.to} for the rest)`
      : ''

    return [header, '```', result.content, '```'].join('\n') + footer
  },
```

- [x] **Step 7: Sharpen `search_project`**

Rewrite `agent/tools/search-project.ts`:

```ts
import { AgentTool } from './registry'
import { MAX_SEARCH_HITS } from '../project-handle'

const SPECIALS = /[.+^${}()|[\]\\]/g

/**
 * Minimal glob matching: `*` stops at a slash, `**` crosses them.
 *
 * Deliberately not a dependency. The agent only ever needs `sections/*.tex`
 * shaped patterns, and a full glob library is a lot of bundle for that.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const source = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .filter(Boolean)
    .map(token => {
      if (token === '**/') return '(?:.*/)?'
      if (token === '**') return '.*'
      if (token === '*') return '[^/]*'
      if (token === '?') return '[^/]'
      return token.replace(SPECIALS, '\\$&')
    })
    .join('')

  return new RegExp(`^${source}$`).test(path)
}

export const searchProjectTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'search_project',
    description:
      'Search the text files in the project for a string or regular expression. Use this instead of guessing at a path.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: {
          type: 'string',
          description: 'Only search files matching this glob, e.g. sections/*.tex',
        },
        contextLines: {
          type: 'number',
          description: 'Lines of surrounding context per hit. Defaults to 1.',
        },
        caseSensitive: { type: 'boolean' },
        regexp: { type: 'boolean' },
      },
      required: ['query'],
    },
  },

  async execute({ query, path, contextLines = 1, caseSensitive, regexp }, handle) {
    const all = await handle.search(query, { caseSensitive, regexp })
    const filtered = path ? all.filter(hit => matchesGlob(hit.path, path)) : all
    const shown = filtered.slice(0, MAX_SEARCH_HITS)

    const cache = new Map<string, string[]>()
    const linesOf = async (filePath: string) => {
      if (!cache.has(filePath)) {
        const { lines } = await handle.readFile(filePath)
        cache.set(filePath, lines)
      }
      return cache.get(filePath)!
    }

    const hits = []
    for (const hit of shown) {
      if (contextLines <= 0) {
        hits.push(hit)
        continue
      }
      const lines = await linesOf(hit.path)
      hits.push({
        ...hit,
        before: lines.slice(Math.max(0, hit.line - 1 - contextLines), hit.line - 1),
        after: lines.slice(hit.line, hit.line + contextLines),
      })
    }

    return { hits, total: filtered.length, truncated: filtered.length > shown.length }
  },
}
```

- [x] **Step 8: Run the tests to verify they pass**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/read-tools.test.ts modules/ai-assist/test/frontend/js/agent/tool-rendering.test.ts
```

Expected: PASS. If an older assertion expected `truncated` to be absent, update it — the field is now always present.

- [x] **Step 9: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

---
### Task 13: `get_compile_log`

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-log.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts`

**Interfaces:**
- Consumes: `handle.lastCompile()` from Task 3, `AgentTool.render` from Task 12.
- Produces: `compileLogTool: AgentTool`, `excerptAround(rawLog, needle, radius)`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts`:

```ts
import { expect } from 'chai'
import {
  compileLogTool,
  excerptAround,
} from '../../../../frontend/js/features/ai-assist/agent/tools/compile-log'
import { createFakeHandle } from './helpers/fake-handle'

const RAW = [
  'This is pdfTeX',
  '(./main.tex',
  '! Undefined control sequence.',
  'l.3 \\foo',
  '        bar',
  '?',
].join('\n')

const COMPILE = {
  status: 'failure',
  errors: [{ message: 'Undefined control sequence.', file: 'main.tex', line: 3 }],
  warnings: [{ message: 'Overfull \\hbox', file: 'main.tex', line: 9 }],
  rawLog: RAW,
}

describe('excerptAround', function () {
  it('returns the matching line with surrounding context', function () {
    const excerpt = excerptAround(RAW, 'Undefined control sequence.', 1)
    expect(excerpt).to.equal('(./main.tex\n! Undefined control sequence.\nl.3 \\foo')
  })

  it('returns null when the message is not in the log', function () {
    expect(excerptAround(RAW, 'nothing like this', 1)).to.equal(null)
  })

  it('clamps at the start of the log', function () {
    expect(excerptAround(RAW, 'This is pdfTeX', 2)).to.include('This is pdfTeX')
  })
})

describe('get_compile_log', function () {
  it('does not suspend and does not compile', async function () {
    const { handle, calls } = createFakeHandle({
      docs: { 'main.tex': 'x' },
      lastCompile: COMPILE,
    })

    await compileLogTool.execute({}, handle)

    expect(compileLogTool.suspends).to.equal(false)
    expect(calls.some(call => call.name === 'compile')).to.equal(false)
  })

  it('returns errors and warnings from the last compile', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })
    const result: any = await compileLogTool.execute({}, handle)

    expect(result.status).to.equal('failure')
    expect(result.errors).to.have.length(1)
    expect(result.warnings).to.have.length(1)
  })

  it('narrows to errors when asked', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })
    const result: any = await compileLogTool.execute({ severity: 'errors' }, handle)

    expect(result.errors).to.have.length(1)
    expect(result.warnings).to.equal(undefined)
  })

  it('caps the number of entries', async function () {
    const many = {
      ...COMPILE,
      errors: Array.from({ length: 10 }, () => COMPILE.errors[0]),
    }
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: many })
    const result: any = await compileLogTool.execute({ maxEntries: 3 }, handle)

    expect(result.errors).to.have.length(3)
    expect(result.truncated).to.equal(true)
  })

  it('attaches raw log excerpts only when asked', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })

    const without: any = await compileLogTool.execute({}, handle)
    expect(without.errors[0].excerpt).to.equal(undefined)

    const with_: any = await compileLogTool.execute({ includeRaw: true }, handle)
    expect(with_.errors[0].excerpt).to.include('l.3 \\foo')
  })

  it('ignores includeRaw when there is no raw log', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'x' },
      lastCompile: { ...COMPILE, rawLog: null },
    })
    const result: any = await compileLogTool.execute({ includeRaw: true }, handle)

    expect(result.errors[0].excerpt).to.equal(undefined)
    expect(result.errors).to.have.length(1)
  })

  it('tells the model to compile when nothing has been built yet', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' } })
    const result: any = await compileLogTool.execute({}, handle)

    expect(result.status).to.equal('none')
    expect(result.message).to.include('compile_project')
  })

  it('renders as readable text rather than escaped JSON', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })
    const result = await compileLogTool.execute({ includeRaw: true }, handle)

    const rendered = compileLogTool.render!(result)
    expect(rendered).to.include('main.tex:3')
    expect(rendered).to.not.include('\\n')
  })
})
```

- [x] **Step 2: Run it to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/tools/compile-log'`.

- [x] **Step 3: Write the tool**

Create `agent/tools/compile-log.ts`:

```ts
import { AgentTool } from './registry'
import { LogEntrySummary } from '../project-handle'

const DEFAULT_MAX_ENTRIES = 20
const EXCERPT_RADIUS = 3

/** Finds a log line and returns it with `radius` lines either side. */
export function excerptAround(
  rawLog: string,
  needle: string,
  radius: number
): string | null {
  const lines = rawLog.split('\n')
  const index = lines.findIndex(line => line.includes(needle))
  if (index === -1) return null

  return lines
    .slice(Math.max(0, index - radius), index + radius + 1)
    .join('\n')
}

function decorate(
  entries: LogEntrySummary[],
  rawLog: string | null,
  includeRaw: boolean
) {
  if (!includeRaw || !rawLog) return entries
  return entries.map(entry => {
    const excerpt = excerptAround(rawLog, entry.message, EXCERPT_RADIUS)
    return excerpt ? { ...entry, excerpt } : entry
  })
}

export const compileLogTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'get_compile_log',
    description:
      'Read the errors and warnings from the last compile without starting a new one. Prefer this over compile_project when you only need to see what already failed.',
    parameters: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['errors', 'warnings', 'all'],
          description: 'Which entries to return. Defaults to all.',
        },
        maxEntries: {
          type: 'number',
          description: `Cap per severity. Defaults to ${DEFAULT_MAX_ENTRIES}.`,
        },
        includeRaw: {
          type: 'boolean',
          description: 'Include raw log lines around each entry',
        },
      },
      required: [],
    },
  },

  async execute(
    { severity = 'all', maxEntries = DEFAULT_MAX_ENTRIES, includeRaw = false },
    handle
  ) {
    const compile = handle.lastCompile()

    if (!compile) {
      return {
        status: 'none',
        message:
          'The project has not been compiled in this session. Call compile_project to build it.',
      }
    }

    const errors = compile.errors.slice(0, maxEntries)
    const warnings = compile.warnings.slice(0, maxEntries)

    const result: Record<string, unknown> = {
      status: compile.status,
      errorCount: compile.errors.length,
      warningCount: compile.warnings.length,
      truncated:
        compile.errors.length > errors.length ||
        compile.warnings.length > warnings.length,
    }

    if (severity === 'all' || severity === 'errors') {
      result.errors = decorate(errors, compile.rawLog, includeRaw)
    }
    if (severity === 'all' || severity === 'warnings') {
      result.warnings = decorate(warnings, compile.rawLog, includeRaw)
    }

    return result
  },

  render(result: any) {
    if (result?.status === 'none') return result.message

    const section = (title: string, entries: any[] = []) => {
      if (entries.length === 0) return []
      return [
        `${title}:`,
        ...entries.map(entry => {
          const where = entry.file
            ? `${entry.file}:${entry.line ?? '?'}`
            : 'unknown location'
          const excerpt = entry.excerpt ? `\n    ${entry.excerpt.split('\n').join('\n    ')}` : ''
          return `  ${where}  ${entry.message}${excerpt}`
        }),
      ]
    }

    return [
      `Last compile: ${result.status} - ${result.errorCount} error(s), ${result.warningCount} warning(s)`,
      ...section('Errors', result.errors),
      ...section('Warnings', result.warnings),
    ].join('\n')
  },
}
```

- [x] **Step 4: Register it**

In `agent/tools/registry.ts`, import `compileLogTool` and add `get_compile_log: compileLogTool` to `TOOLS`.

- [x] **Step 5: Run the test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts
```

Expected: PASS, 11 passing.

- [x] **Step 6: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

---

### Task 14: `create_file`

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/create-file.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/edit-approval-card.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/create-file-tool.test.ts`

**Interfaces:**
- Consumes: `handle.createFile` from Task 3 (stubbed there, implemented here).
- Produces: `createFileTool: AgentTool`, `validateNewPath(path, existing): string | null`.

This reverses the out-of-scope decision recorded at `2026-09-10-ai-assist-project-agent-design.md:37`. Deletion and renaming stay out of scope.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/create-file-tool.test.ts`:

```ts
import { expect } from 'chai'
import {
  createFileTool,
  validateNewPath,
} from '../../../../frontend/js/features/ai-assist/agent/tools/create-file'
import { createFakeHandle } from './helpers/fake-handle'

const DOCS = { 'main.tex': '\\documentclass{article}' }

describe('validateNewPath', function () {
  const existing = ['main.tex']

  it('accepts an ordinary new path', function () {
    expect(validateNewPath('sections/new.tex', existing)).to.equal(null)
  })

  it('rejects a path that already exists', function () {
    expect(validateNewPath('main.tex', existing)).to.include('already exists')
  })

  it('rejects traversal', function () {
    expect(validateNewPath('../escape.tex', existing)).to.include('..')
  })

  it('rejects an absolute path', function () {
    expect(validateNewPath('/etc/passwd', existing)).to.match(/absolute|relative/i)
  })

  it('rejects a binary extension', function () {
    expect(validateNewPath('figure.pdf', existing)).to.include('binary')
  })
})

describe('create_file', function () {
  it('suspends, because the user must approve it', function () {
    expect(createFileTool.suspends).to.equal(true)
  })

  it('creates a file and reports success', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })
    const result: any = await createFileTool.execute(
      { path: 'sections/new.tex', content: '\\section{New}' },
      handle
    )

    expect(result.status).to.equal('applied')
    const call = calls.find(entry => entry.name === 'createFile')
    expect(call!.args).to.deep.equal({
      path: 'sections/new.tex',
      content: '\\section{New}',
    })
  })

  it('refuses to overwrite an existing file', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })
    const result: any = await createFileTool.execute(
      { path: 'main.tex', content: 'x' },
      handle
    )

    expect(result.error).to.include('already exists')
    expect(calls.some(entry => entry.name === 'createFile')).to.equal(false)
  })

  it('requires content', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const result: any = await createFileTool.execute({ path: 'new.tex', content: '' }, handle)
    expect(result.error).to.match(/content/i)
  })

  it('reports a rejection as a normal outcome, not an error', async function () {
    const { handle } = createFakeHandle({
      docs: DOCS,
      onCreate: () => ({ status: 'rejected', note: 'not now' }),
    })
    const result: any = await createFileTool.execute(
      { path: 'new.tex', content: 'x' },
      handle
    )

    expect(result.status).to.equal('rejected')
    expect(result.message).to.include('rejected')
  })
})
```

- [x] **Step 2: Run it to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/create-file-tool.test.ts
```

Expected: FAIL — `Cannot find module '.../agent/tools/create-file'`.

- [x] **Step 3: Write the tool**

Create `agent/tools/create-file.ts`:

```ts
import { AgentTool } from './registry'

const BINARY_EXTENSIONS = [
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.eps', '.zip', '.gz', '.ttf', '.otf',
]

/** Returns an error message, or null when the path is acceptable. */
export function validateNewPath(path: string, existing: string[]): string | null {
  if (!path || !path.trim()) return 'A path is required.'
  if (path.startsWith('/')) {
    return 'The path must be relative to the project root, not absolute.'
  }
  if (path.split('/').includes('..')) {
    return 'The path must not contain "..".'
  }
  if (existing.includes(path)) {
    return `${path} already exists. Use edit_file to change it.`
  }
  if (BINARY_EXTENSIONS.some(extension => path.toLowerCase().endsWith(extension))) {
    return `${path} looks like a binary file, which this tool cannot create.`
  }
  return null
}

export const createFileTool: AgentTool = {
  // The user reviews the new file before it is added.
  suspends: true,
  spec: {
    name: 'create_file',
    description:
      'Create a new text file in the project. The path must not already exist. The user reviews the new file before it is added, and may reject it.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the project root, e.g. sections/new.tex',
        },
        content: { type: 'string', description: 'The full contents of the new file' },
      },
      required: ['path', 'content'],
    },
  },

  async execute({ path, content }, handle) {
    if (typeof content !== 'string' || content.length === 0) {
      return { error: 'content must be the full text of the new file.' }
    }

    const files = await handle.listFiles()
    const problem = validateNewPath(path, files.map(file => file.path))
    if (problem) return { error: problem }

    const outcome = await handle.createFile({ path, content })

    switch (outcome.status) {
      case 'applied':
        return { status: 'applied', message: `Created ${path}.` }
      case 'rejected':
        return {
          status: 'rejected',
          note: outcome.note,
          message: 'The user rejected this new file.',
        }
      default:
        return outcome
    }
  },
}
```

- [x] **Step 4: Register it**

In `agent/tools/registry.ts`, import `createFileTool` and add `create_file: createFileTool` to `TOOLS`.

- [x] **Step 5: Run the test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/create-file-tool.test.ts
```

Expected: PASS, 10 passing.

- [x] **Step 6: Implement `createFile` on the real handle**

Replace the Task 3 stub in `agent/use-project-handle.ts`. Creation is two steps because the API creates an empty document: create the entity, then write the content through the same editor bridge `proposeEdit` already uses.

```ts
import { syncCreateEntity } from '@/features/file-tree/util/sync-mutation'
import { findByNameInFolder, pathInFolder } from '@/features/file-tree/util/path'
```

```ts
  const createFile = useCallback(
    async ({ path, content }: { path: string; content: string }): Promise<EditOutcome> => {
      if (!fileTreeData) return { status: 'drifted' }

      const decision = await requestApproval({ path, oldText: '', newText: content })
      if (!decision.accepted) {
        return { status: 'rejected', note: decision.note }
      }

      const segments = path.split('/')
      const name = segments.pop()!
      const parent = folderIdForPath(fileTreeData, segments)
      if (!parent) return { status: 'noMatch' }

      const doc = await syncCreateEntity(project._id, parent, {
        endpoint: 'doc',
        name,
      })

      await openDocWithId(doc._id)

      const applied = await askEditor<{ status: string }>(
        'aiAssist:agentApplyEdit',
        'aiAssist:agentApplyEditResult',
        { from: 1, to: 1, oldText: '', replacement: content }
      )

      return applied?.status === 'applied' ? { status: 'applied' } : { status: 'drifted' }
    },
    [fileTreeData, project._id, openDocWithId, requestApproval]
  )
```

Add a `folderIdForPath(rootFolder, segments)` helper beside `findUniqueSpan` in the same file: walk `segments` through `folder.folders` by name and return the `_id` of the last one, or the root folder's `_id` when `segments` is empty. Return `null` if any segment is missing — the agent must create parent folders explicitly, which is out of scope, so a missing folder is an honest failure rather than a silent one.

- [x] **Step 7: Render a creation as an all-additions diff**

In `components/agent/edit-approval-card.tsx`, treat an empty `oldText` as a creation: show the path with a "new file" badge and render every line of `newText` as an addition. The existing diff renderer already handles an empty original; the change is the label and the badge, not the diff logic.

- [x] **Step 8: Run the whole module suite**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js
```

Expected: all module tests pass. Phase 2 is complete: nine tools, all LaTeX-aware where it matters.

- [x] **Step 9: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

---
## Phase 3 — Attachments

### Task 15: Resolving attachments at send time

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/attachments.ts`
- Test: `modules/ai-assist/test/frontend/js/context/resolve-attachments.test.ts`

**Interfaces:**
- Consumes: `AttachmentRef`, `Attachment` (Task 2); `ProjectHandle` (Task 3).
- Produces:
  - `resolveAttachments(refs: AttachmentRef[], handle: ProjectHandle): Promise<Attachment[]>`
  - `parseAttachmentRef(token: string): AttachmentRef | null`

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/context/resolve-attachments.test.ts`:

```ts
import { expect } from 'chai'
import {
  parseAttachmentRef,
  resolveAttachments,
} from '../../../../frontend/js/features/ai-assist/agent/context/attachments'
import { createFakeHandle } from '../agent/helpers/fake-handle'

const DOCS = {
  'main.tex': 'one\ntwo\nthree\nfour\nfive',
  'refs.bib': '@book{a}',
}

describe('parseAttachmentRef', function () {
  it('parses a bare path', function () {
    expect(parseAttachmentRef('main.tex')).to.deep.equal({ path: 'main.tex' })
  })

  it('parses a line range', function () {
    expect(parseAttachmentRef('sections/results.tex:40-80')).to.deep.equal({
      path: 'sections/results.tex',
      from: 40,
      to: 80,
    })
  })

  it('parses a single line as a one-line range', function () {
    expect(parseAttachmentRef('main.tex:12')).to.deep.equal({
      path: 'main.tex',
      from: 12,
      to: 12,
    })
  })

  it('rejects an empty token', function () {
    expect(parseAttachmentRef('')).to.equal(null)
  })

  it('treats a colon with no numbers as part of the path', function () {
    expect(parseAttachmentRef('odd:name.tex')).to.deep.equal({ path: 'odd:name.tex' })
  })

  it('swaps a reversed range rather than returning nothing', function () {
    expect(parseAttachmentRef('main.tex:9-2')).to.deep.equal({
      path: 'main.tex',
      from: 2,
      to: 9,
    })
  })
})

describe('resolveAttachments', function () {
  it('resolves a whole file', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const [attachment] = await resolveAttachments([{ path: 'refs.bib' }], handle)

    expect(attachment.text).to.equal('@book{a}')
  })

  it('resolves a line range', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const [attachment] = await resolveAttachments(
      [{ path: 'main.tex', from: 2, to: 3 }],
      handle
    )

    expect(attachment.text).to.equal('two\nthree')
  })

  it('marks a missing file as gone instead of throwing', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const [attachment] = await resolveAttachments([{ path: 'ghost.tex' }], handle)

    expect(attachment.text).to.equal(null)
    expect(attachment.path).to.equal('ghost.tex')
  })

  it('marks a binary as gone rather than sending bytes to the model', async function () {
    const { handle } = createFakeHandle({ docs: DOCS, binaries: ['plot.pdf'] })
    const [attachment] = await resolveAttachments([{ path: 'plot.pdf' }], handle)

    expect(attachment.text).to.equal(null)
  })

  it('resolves several at once, preserving order', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    const resolved = await resolveAttachments(
      [{ path: 'refs.bib' }, { path: 'main.tex', from: 1, to: 1 }],
      handle
    )

    expect(resolved.map(entry => entry.path)).to.deep.equal(['refs.bib', 'main.tex'])
    expect(resolved[1].text).to.equal('one')
  })

  it('returns an empty array for no refs', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })
    expect(await resolveAttachments([], handle)).to.deep.equal([])
  })
})
```

- [x] **Step 2: Run it to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/resolve-attachments.test.ts
```

Expected: FAIL — `parseAttachmentRef is not a function`.

- [x] **Step 3: Add the resolver**

Append to `agent/context/attachments.ts`:

```ts
import { ProjectHandle } from '../project-handle'
import { Attachment, AttachmentRef } from './types'

const RANGE_RE = /^(.*):(\d+)(?:-(\d+))?$/

/** Parses `path`, `path:12`, or `path:40-80` from an @-mention token. */
export function parseAttachmentRef(token: string): AttachmentRef | null {
  const trimmed = token.trim()
  if (!trimmed) return null

  const match = trimmed.match(RANGE_RE)
  if (!match) return { path: trimmed }

  const from = Number(match[2])
  const to = match[3] ? Number(match[3]) : from

  return {
    path: match[1],
    from: Math.min(from, to),
    to: Math.max(from, to),
  }
}

/**
 * Reads each attachment's text once, at send time.
 *
 * A file that has gone resolves to `text: null` rather than throwing: a
 * conversation should survive the user deleting something it referred to.
 */
export async function resolveAttachments(
  refs: AttachmentRef[],
  handle: ProjectHandle
): Promise<Attachment[]> {
  const files = await handle.listFiles()

  return Promise.all(
    refs.map(async ref => {
      const file = files.find(candidate => candidate.path === ref.path)
      if (!file || file.type === 'binary') return { ...ref, text: null }

      try {
        const range = ref.from && ref.to ? { from: ref.from, to: ref.to } : undefined
        const { lines } = await handle.readFile(ref.path, range)
        return { ...ref, text: lines.join('\n') }
      } catch {
        return { ...ref, text: null }
      }
    })
  )
}
```

- [x] **Step 4: Run the test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/resolve-attachments.test.ts
```

Expected: PASS, 13 passing.

- [x] **Step 5: Verify — do not commit**

```bash
git status --short modules/ai-assist
```

---

### Task 16: `@`-mention and attachment chips in the composer

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-composer.tsx`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx`
- Modify: `services/web/frontend/stylesheets/components/ai-assist.scss`
- Modify: `services/web/locales/en.json`
- Test: `modules/ai-assist/test/frontend/js/components/agent-composer-mentions.test.tsx`

**Interfaces:**
- Consumes: `parseAttachmentRef` (Task 15), `AttachmentRef` (Task 2).
- Produces: `AgentComposer` gains a `paths: string[]` prop and an `onSend(text, attachments: AttachmentRef[])` signature; exports `mentionQueryAt(value: string, caret: number): string | null`.

The composer takes `paths` as a prop rather than reading the file tree itself, which is what keeps it testable without an editor context.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/components/agent-composer-mentions.test.tsx`:

```tsx
import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  AgentComposer,
  mentionQueryAt,
} from '../../../../frontend/js/features/ai-assist/components/agent/agent-composer'

const PATHS = ['main.tex', 'sections/results.tex', 'refs.bib']

function renderComposer(overrides: Partial<Parameters<typeof AgentComposer>[0]> = {}) {
  const onSend = sinon.stub()
  render(
    <AgentComposer
      running={false}
      paths={PATHS}
      onSend={onSend}
      onStop={() => {}}
      {...overrides}
    />
  )
  return { onSend }
}

function type(value: string) {
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value } })
  return textarea
}

describe('mentionQueryAt', function () {
  it('finds the token being typed after an @', function () {
    expect(mentionQueryAt('look at @sec', 12)).to.equal('sec')
  })

  it('returns an empty query immediately after a bare @', function () {
    expect(mentionQueryAt('look at @', 9)).to.equal('')
  })

  it('returns null when there is no @ before the caret', function () {
    expect(mentionQueryAt('look at this', 12)).to.equal(null)
  })

  it('stops at whitespace so a finished mention does not reopen the menu', function () {
    expect(mentionQueryAt('@main.tex and then', 18)).to.equal(null)
  })

  it('ignores an @ after the caret', function () {
    expect(mentionQueryAt('abc @def', 3)).to.equal(null)
  })
})

describe('AgentComposer attachments', function () {
  it('opens a file menu when the user types @', function () {
    renderComposer()
    type('@')
    expect(screen.getByRole('listbox')).to.exist
    expect(screen.getByRole('option', { name: /main\.tex/ })).to.exist
  })

  it('filters the menu as the user types', function () {
    renderComposer()
    type('@res')
    expect(screen.getByRole('option', { name: /sections\/results\.tex/ })).to.exist
    expect(screen.queryByRole('option', { name: /refs\.bib/ })).to.equal(null)
  })

  it('adds a chip and removes the mention text when a file is picked', function () {
    renderComposer()
    type('explain @res')
    fireEvent.click(screen.getByRole('option', { name: /sections\/results\.tex/ }))

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).to.equal('explain ')
    expect(screen.getByText('sections/results.tex')).to.exist
  })

  it('keeps a typed line range on the chip', function () {
    renderComposer()
    type('@sections/results.tex:40-80 ')
    expect(screen.getByText('sections/results.tex:40-80')).to.exist
  })

  it('sends the attachments alongside the text', function () {
    const { onSend } = renderComposer()
    type('explain @res')
    fireEvent.click(screen.getByRole('option', { name: /sections\/results\.tex/ }))
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(onSend.lastCall.args[0]).to.equal('explain')
    expect(onSend.lastCall.args[1]).to.deep.equal([{ path: 'sections/results.tex' }])
  })

  it('removes a chip when its close button is clicked', function () {
    renderComposer()
    type('@main.tex ')
    fireEvent.click(screen.getByRole('button', { name: /remove attachment/i }))
    expect(screen.queryByText('main.tex')).to.equal(null)
  })

  it('opens the same menu from the paperclip button', function () {
    renderComposer()
    fireEvent.click(screen.getByRole('button', { name: /attach context/i }))
    expect(screen.getByRole('listbox')).to.exist
  })

  it('closes the menu on Escape without sending', function () {
    const { onSend } = renderComposer()
    const textarea = type('@')
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).to.equal(null)
    expect(onSend.called).to.equal(false)
  })

  it('does not send on Enter while the menu is open', function () {
    const { onSend } = renderComposer()
    const textarea = type('hi @')
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSend.called).to.equal(false)
  })

  it('clears attachments after sending', function () {
    renderComposer()
    type('@main.tex ')
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(screen.queryByText('main.tex')).to.equal(null)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/components/agent-composer-mentions.test.tsx
```

Expected: FAIL — `mentionQueryAt` is not exported.

- [x] **Step 3: Add the mention parser**

At the top of `components/agent/agent-composer.tsx`:

```ts
const MENTION_RE = /@([^\s@]*)$/

/**
 * The `@` token being typed immediately before the caret, or null.
 *
 * Stops at whitespace so a completed mention does not reopen the menu on every
 * later keystroke.
 */
export function mentionQueryAt(value: string, caret: number): string | null {
  const match = value.slice(0, caret).match(MENTION_RE)
  return match ? match[1] : null
}
```

- [x] **Step 4: Rewire the composer**

Change the props and state:

```ts
export function AgentComposer({
  running,
  paths,
  onSend,
  onStop,
}: {
  running: boolean
  paths: string[]
  onSend: (text: string, attachments: AttachmentRef[]) => void
  onStop: () => void
}) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<AttachmentRef[]>([])
  const [query, setQuery] = useState<string | null>(null)
```

On change, recompute the query, and commit a mention as a chip as soon as it is followed by whitespace — that is what makes `@main.tex ` become a chip without a click:

```ts
  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value
    const caret = event.target.selectionStart ?? next.length

    const completed = next.match(/@([^\s@]+)\s$/)
    if (completed) {
      const ref = parseAttachmentRef(completed[1])
      if (ref && paths.includes(ref.path)) {
        setAttachments(current => [...current, ref])
        setValue(next.slice(0, completed.index) + next.slice(completed.index! + completed[0].length))
        setQuery(null)
        return
      }
    }

    setValue(next)
    setQuery(mentionQueryAt(next, caret))
  }
```

Selecting from the menu replaces the in-progress token:

```ts
  const choose = (path: string) => {
    setAttachments(current => [...current, { path }])
    setValue(current => current.replace(MENTION_RE, ''))
    setQuery(null)
  }
```

Filter the menu and render it as a listbox:

```tsx
  const matches =
    query === null
      ? []
      : paths.filter(path => path.toLowerCase().includes(query.toLowerCase())).slice(0, 8)

  {query !== null && matches.length > 0 && (
    <ul className="ai-assist-mention-menu" role="listbox">
      {matches.map(path => (
        <li key={path}>
          <button type="button" role="option" onClick={() => choose(path)}>
            {path}
          </button>
        </li>
      ))}
    </ul>
  )}
```

Render a chip per attachment, labelled with the range when it has one, alongside the existing selection chip:

```tsx
  {attachments.map((attachment, index) => (
    <span className="ai-assist-selection-chip" key={`${attachment.path}-${index}`}>
      <span className="ai-assist-selection-chip-label">
        {attachment.from && attachment.to
          ? `${attachment.path}:${attachment.from}-${attachment.to}`
          : attachment.path}
      </span>
      <button
        type="button"
        aria-label={t('remove_attachment', 'Remove attachment')}
        onClick={() => setAttachments(current => current.filter((_unused, at) => at !== index))}
      >
        ×
      </button>
    </span>
  ))}
```

Guard Enter and Escape while the menu is open, and clear attachments in `send()`:

```ts
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && query !== null) {
      event.preventDefault()
      setQuery(null)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      // Enter picks from the menu rather than sending a half-typed mention.
      if (query !== null) return
      send()
    }
  }
```

```ts
  const send = () => {
    const trimmed = value.trim()
    if (!trimmed && attachments.length === 0) return
    onSend(trimmed, attachments)
    setValue('')
    setAttachments([])
    setQuery(null)
  }
```

Give the paperclip an `onClick` that opens the menu with an empty query:

```tsx
  onClick={() => setQuery('')}
```

- [x] **Step 5: Run the test to verify it passes**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/components/agent-composer-mentions.test.tsx
```

Expected: PASS, 16 passing.

- [x] **Step 6: Wire the panel**

In `components/agent/agent-panel.tsx`:

- pass `paths={files.map(file => file.path)}` from the file list the panel already holds;
- accept the new `onSend(text, refs)` signature, call `resolveAttachments(refs, handle)` before building the snapshot, and pass the resolved `attachments` into `renderEnvelope` and onto the transcript entry, exactly as Task 9 Step 6 laid out;
- render the stored `entry.attachments` as read-only chips on past user turns, so a reloaded conversation still shows what was attached.

- [x] **Step 7: Style the menu and chips**

In `services/web/frontend/stylesheets/components/ai-assist.scss`, add `.ai-assist-mention-menu` positioned above the textarea, following the spacing and colour variables the file already uses for `.ai-assist-selection-chip`. Add `remove_attachment` and `attach_file` to `services/web/locales/en.json` if they are not already present.

- [x] **Step 8: Run the whole module suite**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js
```

Expected: all module tests pass.

- [x] **Step 9: Redeploy the dev server and look at it**

Tests passing is not the finish line for a UI change. Rebuild and restart the worktree's dev server, open a project, and check by hand that: typing `@` lists files, a line range shows on the chip, the attached text reaches the model, and a long conversation still answers rather than erroring.

- [x] **Step 10: Verify — do not commit**

```bash
git status --short modules/ai-assist services/web
```

Expected: a working tree full of changes and no new commits. Hand the diff to the repository owner for review.

---

## Notes for the executor

**Order matters between Tasks 1 and 9.** Task 1 deletes `agent/system-prompt.ts` while `run-agent.ts` still imports it, and Task 2 adds three `ProjectHandle` methods before anything implements them. The module does not typecheck in between. That is deliberate — each task stays small and independently reviewable — but it means you should not treat a typecheck failure during Tasks 1–8 as a defect. Run the test file each task names, not the whole suite, until Task 9 closes the loop.

**The one test that must never be weakened** is `build-request.test.ts`'s "builds turn 2 as a byte-exact extension of turn 1". Every other change here is an improvement; that one is the invariant the caching design rests on. If it starts failing, something has begun re-deriving context that should have been frozen, and the fix is to find that, not to relax the assertion.
