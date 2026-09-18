# AI Assist Harness Comprehension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent understand large LaTeX projects at low token cost: a memoized client-side structural index, one filterable orientation tool replacing three, structure-aware reads, a slim frozen envelope, a cost-aware static prompt, and a rescue path for tool calls emitted as text.

**Architecture:** All comprehension is computed in the browser from the project snapshot it already holds; nothing new is fetched and nothing enters a request unless a tool asks for it. The frozen-envelope and prefix-cache machinery from the 2026-09-11 design is untouched in mechanism.

**Tech Stack:** TypeScript, React 18, Mocha + Chai + @testing-library/react, Overleaf web module `modules/ai-assist`.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-13-ai-assist-harness-comprehension-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **NO GIT WRITE COMMANDS.** Do not run `git add`, `git commit`, `git push`, `git stash`, `git branch`, `git rebase`, or `git checkout -b` at any point. This overrides the commit step in the subagent-driven-development and executing-plans skills. All work stays as uncommitted working-tree modifications; verification uses `git status --short` only.
- **`SYSTEM_PROMPT` byte-freeze invariant:** it is a constant and no project data is interpolated into it. Task 6 rewrites it once, in full; no other task touches it.
- **Frontend only.** No route, no controller, no server-side inference proxy.
- **Default off.** With `AI_ASSIST_ENABLED` unset the instance behaves like upstream Overleaf CE.
- **Test command — never `npm run test:frontend`** (broken in this sandbox: unquoted `--grep` interpolation plus an unrelated `.jsx` ESM-loader crash in `modules/user-activate`). From `overleaf/services/web`:

  ```
  NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
    --extension js,jsx,mjs,ts,tsx \
    --grep="<pattern>" \
    --require test/frontend/bootstrap.js \
    --ignore '**/*.spec.{js,jsx,ts,tsx}' \
    --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
    modules/ai-assist/test/frontend
  ```

  Omit `--grep` for the whole module. Baseline at plan time: **443 passing, 0 failing, 0 pending**. `CoreWiring.test.mjs` is vitest: `npx vitest run modules/ai-assist/test/unit`.
- **A parallel actor edits this worktree.** Re-read every file immediately before editing it; treat unexpected content as current, never as drift to revert. Never delete or rewrite files outside your task's file list.
- **Import forms that have bitten this module before:** `ThinkingBlock`, `ToolCallCard`, `MarkdownContent`, `EditApprovalCard`, `DiffView` (default), `createFakeHandle` returns `{ handle, calls, approvalContexts }` — always destructure.

---

## File Structure

| Path | Change |
|---|---|
| `agent/context/project-index.ts` | Create — environment scan, index build, section matching |
| `agent/project-handle.ts` | Add `index(): Promise<ProjectIndex>` |
| `agent/use-project-handle.ts` | Implement `index()` from `projectSnapshot` |
| `test/.../helpers/fake-handle.ts` | Implement `index()` from its `docs` map |
| `agent/tools/project-map.ts` | Create — the merged orientation tool |
| `agent/tools/outline-project.ts`, `list-references.ts`, `list-files.ts` | Delete |
| `agent/tools/registry.ts` | Swap the three for `project_map` |
| `agent/tools/read-file.ts` | Add `section=` reads |
| `agent/context/project-context.ts` | Slim `<files>` block |
| `agent/context/system-prompt.ts` | Full rewrite (Task 6 only) |
| `agent/tools/*.ts` descriptions | Rewritten in Task 6 |
| `agent/text-tool-call.ts` | Create — fenced/whole-message tool-call rescue |
| `agent/run-agent.ts` | Wire the rescue into the stream loop |
| `components/agent/tool-call-card.tsx` | `project_map` icon + summary |
| `agent/fix-run.ts` | Task-block tool list (5 names) |
| Tests | `project-index.test.ts`, `project-map-tool.test.ts` (create); `outline-tool.test.ts`, `references-tool.test.ts` (delete); `read-tools.test.ts`, `project-context.test.ts`, `run-agent.test.ts`, `system-prompt.test.ts` (extend) |

---

# Phase 1 — The index

## Task 1: `project-index.ts`

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-index.ts`
- Test: `modules/ai-assist/test/frontend/js/context/project-index.test.ts` (create)

**Interfaces:**
- Produces: `EnvironmentCount`, `FileIndex`, `ProjectIndex`, `scanEnvironments(content): EnvironmentCount[]`, `hashContent(content): string`, `buildProjectIndex({ docs, rootPath }, previous?): ProjectIndex`, `matchSection(outline, query): SectionMatch`.
- Consumes: `parseOutline`, `Outline` from `./outline`; `extractReferences`, `References` from `./references`.

**Ruling carried from design review:** `parseOutline` and `extractReferences` are cross-file (root-first ordering; `resolved` flags computed against all labels/bib keys), so per-file memoization *of those two* is impossible without changing their semantics. Memoization therefore has two honest units: (a) a whole-index identity short-circuit — if every file hash matches `previous`, return `previous` untouched; (b) a per-file content-hash cache for the new environment scan. The two existing parsers re-run in full on any change; they are linear regex passes over in-memory text and cost milliseconds.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect } from 'chai'
import {
  buildProjectIndex,
  hashContent,
  matchSection,
  scanEnvironments,
} from '../../../../frontend/js/features/ai-assist/agent/context/project-index'

const PAPER = {
  'main.tex': [
    '\\documentclass{article}',
    '\\usepackage{graphicx}',
    '\\begin{document}',
    '\\section{Intro}',
    '\\begin{figure}',
    'x',
    '\\end{figure}',
    '\\section{Method}',
    '\\input{method.tex}',
    '\\end{document}',
  ].join('\n'),
  'method.tex': [
    '\\subsection{Setup}',
    '\\begin{table}',
    'y',
    '\\end{table}',
    '\\begin{table}',
    'z',
    '\\end{table}',
  ].join('\n'),
}

describe('scanEnvironments', function () {
  it('counts environments with their line numbers', function () {
    const envs = scanEnvironments(PAPER['main.tex'])
    const figure = envs.find(e => e.name === 'figure')
    expect(figure?.count).to.equal(1)
    expect(figure?.lines).to.deep.equal([5])
  })

  it('counts repeated environments in one file', function () {
    const envs = scanEnvironments(PAPER['method.tex'])
    expect(envs.find(e => e.name === 'table')?.count).to.equal(2)
  })

  it('ignores commented-out environments', function () {
    expect(scanEnvironments('% \\begin{figure}\nreal text')).to.deep.equal([])
  })
})

describe('buildProjectIndex', function () {
  it('returns the previous index untouched when nothing changed', function () {
    const first = buildProjectIndex({ docs: PAPER, rootPath: 'main.tex' })
    const second = buildProjectIndex(
      { docs: { ...PAPER }, rootPath: 'main.tex' },
      first
    )
    expect(second).to.equal(first)
  })

  it('rebuilds when a file changes and reflects the new structure', function () {
    const first = buildProjectIndex({ docs: PAPER, rootPath: 'main.tex' })
    const changed = {
      ...PAPER,
      'main.tex': PAPER['main.tex'].replace('\\section{Method}', '\\section{Methods}'),
    }
    const second = buildProjectIndex({ docs: changed, rootPath: 'main.tex' }, first)
    expect(second).to.not.equal(first)
    expect(second.outline.sections.map(s => s.title)).to.include('Methods')
  })

  it('carries the outline and references across the whole graph', function () {
    const index = buildProjectIndex({ docs: PAPER, rootPath: 'main.tex' })
    expect(index.outline.documentClass).to.equal('article')
    expect(index.outline.packages).to.deep.equal(['graphicx'])
    // method.tex is reached through \input, so its section is in the tree.
    expect(index.outline.sections.map(s => s.title)).to.include('Setup')
  })

  it('flags files over the size cap instead of parsing them', function () {
    const huge = 'x'.repeat(600 * 1024)
    const index = buildProjectIndex({
      docs: { ...PAPER, 'big.tex': huge },
      rootPath: 'main.tex',
    })
    const big = index.files.find(f => f.path === 'big.tex')
    expect(big?.tooLarge).to.equal(true)
    expect(big?.environments).to.deep.equal([])
  })
})

describe('matchSection', function () {
  const outline = buildProjectIndex({ docs: PAPER, rootPath: 'main.tex' }).outline

  it('matches a title case-insensitively with commands stripped', function () {
    const match = matchSection(outline, 'method')
    expect(match.kind).to.equal('exact')
  })

  it('matches a unique prefix', function () {
    const match = matchSection(outline, 'intro')
    expect(match.kind).to.equal('exact')
  })

  it('lists candidates when ambiguous rather than guessing', function () {
    const ambiguous = buildProjectIndex({
      docs: {
        'main.tex': '\\section{Data}\n\\section{Data Sets}\n',
      },
      rootPath: 'main.tex',
    }).outline
    const match = matchSection(ambiguous, 'data')
    expect(match.kind).to.equal('ambiguous')
    if (match.kind === 'ambiguous') expect(match.candidates).to.have.length(2)
  })

  it('reports none for an unknown section', function () {
    expect(matchSection(outline, 'conclusion').kind).to.equal('none')
  })
})

describe('hashContent', function () {
  it('is stable and length-aware', function () {
    expect(hashContent('abc')).to.equal(hashContent('abc'))
    expect(hashContent('abc')).to.not.equal(hashContent('abd'))
    expect(hashContent('ab')).to.not.equal(hashContent('abc'))
  })
})
```

- [ ] **Step 2: Run to see them fail**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx --grep="scanEnvironments|buildProjectIndex|matchSection|hashContent" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { Outline, OutlineSection, parseOutline } from './outline'
import { References, extractReferences } from './references'

/** Above this a file is listed but never parsed; parsing it would cost more than it can return. */
export const MAX_INDEXED_BYTES = 512 * 1024

/** Bounds the line list per environment so a figure-heavy paper cannot bloat the index. */
const MAX_ENV_LINES = 50

const ENV_NAMES = [
  'figure',
  'table',
  'equation',
  'align',
  'algorithm',
  'theorem',
  'lstlisting',
  'tikzpicture',
]

export type EnvironmentCount = { name: string; count: number; lines: number[] }

export type FileIndex = {
  path: string
  hash: string
  tooLarge: boolean
  environments: EnvironmentCount[]
}

export type ProjectIndex = {
  /** Identity over every file's path and hash. Unchanged means reuse. */
  hash: string
  rootPath: string | null
  outline: Outline
  references: References
  files: FileIndex[]
}

/** djb2 with a length prefix: deterministic, cheap, collision-irrelevant here. */
export function hashContent(content: string): string {
  let h = 5381
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0
  }
  return `${content.length}:${(h >>> 0).toString(16)}`
}

function uncomment(line: string): string {
  const index = line.search(/(?<!\\)%/)
  return index === -1 ? line : line.slice(0, index)
}

/**
 * Counts the environments a reader of a paper asks about ("where are the
 * figures?") that the section tree does not show. One regex pass per file.
 */
export function scanEnvironments(content: string): EnvironmentCount[] {
  const found = new Map<string, number[]>()

  content.split('\n').forEach((rawLine, index) => {
    const line = uncomment(rawLine)
    for (const name of ENV_NAMES) {
      const re = new RegExp(`\\\\begin\\{${name}\\*?\\}`)
      if (re.test(line)) {
        const lines = found.get(name) ?? []
        if (lines.length < MAX_ENV_LINES) lines.push(index + 1)
        found.set(name, lines)
      }
    }
  })

  return [...found.entries()]
    .map(([name, lines]) => ({ name, count: lines.length, lines }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
```
Note `count` is the true count while `lines` is capped; a file with 60 figures reports `count: 60` and 50 lines.

Continuing the module:

```ts
// Per-file environment cache, keyed by content hash. A keystroke reparses one
// file; everything else is a map hit. Bounded so a long session cannot grow it
// without limit.
const envCache = new Map<string, EnvironmentCount[]>()
const ENV_CACHE_MAX = 500

function environmentsFor(path: string, content: string): EnvironmentCount[] {
  if (!path.endsWith('.tex')) return []
  const hash = hashContent(content)
  const cached = envCache.get(hash)
  if (cached) return cached
  const scanned = scanEnvironments(content)
  if (envCache.size >= ENV_CACHE_MAX) envCache.clear()
  envCache.set(hash, scanned)
  return scanned
}

/**
 * Builds (or reuses) the structural index over the whole project.
 *
 * parseOutline and extractReferences are cross-file by nature — section order
 * follows the root document and resolution flags compare against every label
 * in the project — so they cannot be memoized per file without changing what
 * they mean. Memoization here is therefore two honest units: this identity
 * short-circuit, and the per-file environment cache above.
 */
export function buildProjectIndex(
  {
    docs,
    rootPath,
  }: { docs: Record<string, string>; rootPath: string | null },
  previous?: ProjectIndex | null
): ProjectIndex {
  const entries = Object.entries(docs)
  const hash = hashContent(
    entries
      .map(([path, content]) => `${path}\u0000${hashContent(content)}`)
      .sort()
      .join('\u0001')
  )

  if (previous && previous.hash === hash && previous.rootPath === rootPath) {
    return previous
  }

  const files: FileIndex[] = entries
    .map(([path, content]) => ({
      path,
      hash: hashContent(content),
      tooLarge: content.length > MAX_INDEXED_BYTES,
      environments:
        content.length > MAX_INDEXED_BYTES
          ? []
          : environmentsFor(path, content),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))

  return {
    hash,
    rootPath,
    outline: parseOutline({ docs, rootPath }),
    references: extractReferences({ docs }),
    files,
  }
}

export type SectionMatch =
  | { kind: 'exact'; section: OutlineSection }
  | { kind: 'ambiguous'; candidates: OutlineSection[] }
  | { kind: 'none' }

/** Titles compared with LaTeX commands stripped, whitespace collapsed, case folded. */
export function normaliseSectionTitle(title: string): string {
  return title
    .replace(/\\[a-zA-Z]+\*?(\{[^}]*\})?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Exact match wins, then a unique prefix. Ambiguity returns the candidates
 * with their line numbers and reads nothing — an unanswered question is
 * cheaper than a wrong read.
 */
export function matchSection(outline: Outline, query: string): SectionMatch {
  const wanted = normaliseSectionTitle(query)
  if (!wanted) return { kind: 'none' }

  const normalised = outline.sections.map(section => ({
    section,
    title: normaliseSectionTitle(section.title),
  }))

  const exact = normalised.filter(entry => entry.title === wanted)
  if (exact.length === 1) return { kind: 'exact', section: exact[0].section }
  if (exact.length > 1) {
    return { kind: 'ambiguous', candidates: exact.map(e => e.section) }
  }

  const prefixes = normalised.filter(entry => entry.title.startsWith(wanted))
  if (prefixes.length === 1) {
    return { kind: 'exact', section: prefixes[0].section }
  }
  if (prefixes.length > 1) {
    return { kind: 'ambiguous', candidates: prefixes.map(e => e.section) }
  }
  return { kind: 'none' }
}
```

- [ ] **Step 4: Run the tests**

Same command as Step 2. Expected: PASS, all 12.

- [ ] **Step 5: Run the module suite**

Expected: 443 + 12 = 455 passing, 0 failing.

- [ ] **Step 6: Verify no commit**

```
git status --short
```

---

## Task 2: `handle.index()`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Modify: `modules/ai-assist/test/frontend/js/agent/helpers/fake-handle.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/handle-context.test.ts` (extend)

**Interfaces:**
- Produces: `ProjectHandle.index(): Promise<ProjectIndex>`. Tasks 3 and 4 consume it.

- [ ] **Step 1: Write the failing test**

Add to `handle-context.test.ts`:

```ts
it('exposes a structural index built from the project snapshot', async function () {
  const { handle } = createFakeHandle({
    docs: { 'main.tex': '\\documentclass{article}\n\\section{Intro}\n' },
    rootDoc: 'main.tex',
  })

  const index = await handle.index()
  expect(index.outline.documentClass).to.equal('article')
  expect(index.outline.sections.map(s => s.title)).to.include('Intro')

  // Identity: an unchanged project returns the same object, so callers can
  // rely on referential equality as a cheap no-change signal.
  const again = await handle.index()
  expect(again).to.equal(index)
})
```

- [ ] **Step 2: Run to see it fail**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx --grep="exposes a structural index" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: FAIL — `handle.index is not a function`.

- [ ] **Step 3: Implement**

In `agent/project-handle.ts`, add to the `ProjectHandle` interface after `lastCompile()`:

```ts
  /**
   * The structural index over every document file: section tree, reference
   * resolution, environment inventory. Built in the browser from the project
   * snapshot; referentially stable while nothing changes.
   */
  index(): Promise<ProjectIndex>
```

with `import { ProjectIndex } from './context/project-index'`.

In `agent/use-project-handle.ts`, inside the hook where `projectSnapshot` is in scope, add:

```ts
  const indexRef = useRef<ProjectIndex | null>(null)

  const index = useCallback(async (): Promise<ProjectIndex> => {
    await projectSnapshot.refresh()
    const docs: Record<string, string> = {}
    for (const path of projectSnapshot.getDocPaths()) {
      const contents = projectSnapshot.getDocContents(path)
      if (contents !== null) docs[path] = contents
    }
    indexRef.current = buildProjectIndex(
      { docs, rootPath: rootDocPath() },
      indexRef.current
    )
    return indexRef.current
  }, [projectSnapshot, rootDocPath])
```

and include `index` in the returned handle object. Import `buildProjectIndex` and the `ProjectIndex` type from `./context/project-index`.

In `test/frontend/js/agent/helpers/fake-handle.ts`, add to the fake handle:

```ts
    let cachedIndex: ProjectIndex | null = null
    async index() {
      cachedIndex = buildProjectIndex(
        { docs: { ...docs }, rootPath: options.rootDoc ?? null },
        cachedIndex
      )
      return cachedIndex
    },
```

with the matching imports.

- [ ] **Step 4: Run the test** — Expected: PASS.

- [ ] **Step 5: Run the module suite** — Expected: 456 passing, 0 failing.

- [ ] **Step 6: Verify no commit**

---

# Phase 2 — The tools

## Task 3: `project_map` replaces three tools

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/project-map.ts`
- Delete: `agent/tools/outline-project.ts`, `agent/tools/list-references.ts`, `agent/tools/list-files.ts`
- Modify: `agent/tools/registry.ts`, `components/agent/tool-call-card.tsx`
- Create: `modules/ai-assist/test/frontend/js/agent/project-map-tool.test.ts`
- Delete: `modules/ai-assist/test/frontend/js/agent/outline-tool.test.ts`, `modules/ai-assist/test/frontend/js/agent/references-tool.test.ts`

**Interfaces:**
- Produces: `projectMapTool` with spec name `project_map`. Consumes `handle.index()` (Task 2) and `handle.listFiles()`.
- `search-project.ts` must export its glob matcher for reuse: if `matchesGlob` is not already exported there, add `export` to it in this task.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect } from 'chai'
import { projectMapTool } from '../../../../frontend/js/features/ai-assist/agent/tools/project-map'
import { createFakeHandle } from './helpers/fake-handle'

const DOCS = {
  'main.tex': [
    '\\documentclass{article}',
    '\\usepackage{graphicx}',
    '\\begin{document}',
    '\\section{Intro}',
    '\\label{sec:intro}',
    '\\begin{figure}',
    'f',
    '\\end{figure}',
    '\\input{sections/method.tex}',
    '\\end{document}',
  ].join('\n'),
  'sections/method.tex': '\\section{Method}\n\\ref{sec:intro}\n\\cite{missing}\n',
  'refs.bib': '@article{present, author={A}, title={B}, year={2020}}\n',
}

async function run(args: Record<string, unknown>) {
  const { handle } = createFakeHandle({ docs: DOCS, rootDoc: 'main.tex' })
  return projectMapTool.execute(args, handle)
}

describe('project_map', function () {
  it('view=outline returns the section tree across the input graph', async function () {
    const result: any = await run({ view: 'outline' })
    expect(result.documentClass).to.equal('article')
    expect(result.sections.map((s: any) => s.title)).to.deep.equal([
      'Intro',
      'Method',
    ])
  })

  it('view=outline with section returns only that subtree and its line range', async function () {
    const result: any = await run({ view: 'outline', section: 'intro' })
    expect(result.sections).to.have.length(1)
    expect(result.range).to.deep.include({ from: 4 })
    expect(result.range.to).to.be.a('number')
  })

  it('view=references reports resolution and can filter to undefined', async function () {
    const all: any = await run({ view: 'references' })
    expect(all.refs).to.have.length(1)
    expect(all.citations.map((c: any) => c.resolved)).to.deep.equal([false])

    const undefinedOnly: any = await run({
      view: 'references',
      undefinedOnly: true,
    })
    expect(undefinedOnly.citations).to.have.length(1)
    expect(undefinedOnly.refs).to.have.length(0)
  })

  it('view=files lists everything and narrows with a glob', async function () {
    const all: any = await run({ view: 'files' })
    expect(all.files.map((f: any) => f.path)).to.include('refs.bib')

    const narrowed: any = await run({ view: 'files', glob: 'sections/*' })
    expect(narrowed.files.map((f: any) => f.path)).to.deep.equal([
      'sections/method.tex',
    ])
  })

  it('view=packages names the file and line that loads each package', async function () {
    const result: any = await run({ view: 'packages' })
    expect(result.documentClass).to.equal('article')
    expect(result.packages).to.deep.include({
      name: 'graphicx',
      path: 'main.tex',
      line: 2,
    })
  })

  it('rejects an unknown view', async function () {
    const result: any = await run({ view: 'vibes' })
    expect(result.error).to.be.a('string')
  })
})
```

- [ ] **Step 2: Run to see them fail** — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `project-map.ts`**

```ts
import { AgentTool } from './registry'
import { matchesGlob } from './search-project'
import { matchSection } from '../context/project-index'

const MAX_FILE_ROWS = 400

export const projectMapTool: AgentTool = {
  suspends: false,
  spec: {
    name: 'project_map',
    description:
      'The cheap way to orient: one call answers structure questions from a prebuilt index instead of reading files. view=outline for the section tree, the \\input graph and line numbers (pass section= to get one subtree with its exact line range); view=references for every \\label, \\ref and \\cite with whether it resolves; view=files for the full file listing (pass glob= to narrow); view=packages for the documentclass and every \\usepackage with the file that loads it. Use this before read_file, not after.',
    parameters: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['outline', 'references', 'files', 'packages'],
        },
        section: {
          type: 'string',
          description: 'outline only: return just this section subtree',
        },
        glob: {
          type: 'string',
          description: 'files only: narrow the listing, e.g. sections/*.tex',
        },
        kind: {
          type: 'string',
          enum: ['labels', 'refs', 'citations', 'all'],
          description: 'references only. Defaults to all.',
        },
        undefinedOnly: {
          type: 'boolean',
          description: 'references only: only unresolved refs and citations',
        },
      },
      required: ['view'],
    },
  },

  async execute(
    {
      view,
      section,
      glob,
      kind = 'all',
      undefinedOnly = false,
    }: {
      view?: string
      section?: string
      glob?: string
      kind?: string
      undefinedOnly?: boolean
    },
    handle
  ) {
    if (
      view !== 'outline' &&
      view !== 'references' &&
      view !== 'files' &&
      view !== 'packages'
    ) {
      return {
        error: `Unknown view: ${view}. Use outline, references, files or packages.`,
      }
    }

    if (view === 'files') {
      const files = await handle.listFiles()
      const listed = glob
        ? files.filter(file => matchesGlob(file.path, glob))
        : files
      const shown = listed.slice(0, MAX_FILE_ROWS)
      return {
        files: shown,
        total: listed.length,
        truncated: listed.length > shown.length,
      }
    }

    const index = await handle.index()

    if (view === 'outline') {
      if (!section) {
        return {
          documentClass: index.outline.documentClass,
          sections: index.outline.sections,
          includes: index.outline.includes,
          notes: index.outline.notes,
        }
      }
      const match = matchSection(index.outline, section)
      if (match.kind === 'none') {
        return {
          error: `No section matches "${section}".`,
          candidates: index.outline.sections.map(s => s.title),
        }
      }
      if (match.kind === 'ambiguous') {
        return {
          error: `"${section}" matches more than one section. Pick one.`,
          candidates: match.candidates.map(c => ({
            title: c.title,
            path: c.path,
            line: c.line,
          })),
        }
      }
      const target = match.section
      const siblings = index.outline.sections
      const startIndex = siblings.indexOf(target)
      const nextPeer = siblings
        .slice(startIndex + 1)
        .find(candidate => candidate.level <= target.level)
      const end = nextPeer
        ? nextPeer.line - 1
        : Number.MAX_SAFE_INTEGER
      return {
        range: { from: target.line, to: end },
        sections: siblings
          .slice(startIndex)
          .filter(candidate => candidate.line < end),
        hint: `read_file with path=${target.path} from=${target.line} to=${
          end === Number.MAX_SAFE_INTEGER ? 'end' : end
        } for the body`,
      }
    }

    if (view === 'packages') {
      return {
        documentClass: index.outline.documentClass,
        packages: index.packages,
      }
    }

    // view === 'references'
    const refs = index.references
    const pick = {
      labels: { labels: refs.labels, duplicateLabels: refs.duplicateLabels },
      refs: { refs: refs.refs },
      citations: { citations: refs.citations, bibKeys: refs.bibKeys },
      all: refs,
    }[kind] ?? refs

    if (!undefinedOnly) return pick

    const filterUnresolved = (uses: any[]) =>
      uses.filter(use => !use.resolved)
    return {
      ...('refs' in pick ? { refs: filterUnresolved(pick.refs as any[]) } : {}),
      ...('citations' in pick
        ? { citations: filterUnresolved(pick.citations as any[]) }
        : {}),
      ...('labels' in pick
        ? { labels: pick.labels, duplicateLabels: pick.duplicateLabels }
        : {}),
      ...('bibKeys' in pick ? { bibKeys: pick.bibKeys } : {}),
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)

    if (result.files) {
      const rows = result.files.map(
        (file: any) =>
          `${file.path}  ${file.type}  ${file.lines ?? Math.round(file.size / 1024) + ' KB'}`
      )
      if (result.truncated) {
        rows.push(`(${result.total - result.files.length} more; narrow with glob=)`)
      }
      return rows.join('\n')
    }

    if (result.packages) {
      return [
        `documentclass: ${result.documentClass ?? 'unknown'}`,
        ...result.packages.map(
          (pkg: any) => `${pkg.name}  (${pkg.path}:${pkg.line})`
        ),
      ].join('\n')
    }

    if (result.sections && result.range) {
      return [
        `section lines ${result.range.from}-${result.range.to}`,
        ...result.sections.map(
          (s: any) => `${'  '.repeat(s.level + 1)}${s.path}:${s.line} ${s.title}`
        ),
        result.hint ?? '',
      ]
        .filter(Boolean)
        .join('\n')
    }

    if (result.sections) {
      return [
        `documentclass: ${result.documentClass ?? 'unknown'}`,
        ...result.sections.map(
          (s: any) => `${'  '.repeat(s.level + 1)}${s.path}:${s.line} ${s.title}`
        ),
        ...result.includes.map(
          (i: any) =>
            `\\input ${i.from}:${i.line} -> ${i.to}${i.resolved ? '' : ' (UNRESOLVED)'}`
        ),
        ...result.notes,
      ].join('\n')
    }

    // references
    const lines: string[] = []
    if (result.labels) {
      lines.push(...result.labels.map((l: any) => `label ${l.key}  ${l.path}:${l.line}`))
      lines.push(...(result.duplicateLabels ?? []).map((k: string) => `DUPLICATE label ${k}`))
    }
    if (result.refs) {
      lines.push(
        ...result.refs.map(
          (r: any) => `${r.command} ${r.key}  ${r.path}:${r.line}  ${r.resolved ? 'ok' : 'UNRESOLVED'}`
        )
      )
    }
    if (result.citations) {
      lines.push(
        ...result.citations.map(
          (c: any) => `${c.command} ${c.key}  ${c.path}:${c.line}  ${c.resolved ? 'ok' : 'MISSING'}`
        )
      )
    }
    if (result.bibKeys) {
      lines.push(...result.bibKeys.map((b: any) => `bib ${b.key}  ${b.path}:${b.line}`))
    }
    return lines.join('\n')
  },
}
```

Package *locations* are not in `Outline` (it stores names only), so the index
carries them: Task 1's `buildProjectIndex` also collects `packages: PackageUse[]`
across all `.tex` files via `scanPackages`, memoized per file hash exactly like
environments (fill each use's `path` when collecting). `view=packages` therefore
returns `{ documentClass, packages }` straight off the index — no scan in the tool.

```ts
export type PackageUse = { name: string; path: string; line: number }

export function scanPackages(
  content: string
): Array<Omit<PackageUse, 'path'>> {
  const uses: Array<Omit<PackageUse, 'path'>> = []
  content.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/(?<!\\)%.*/, '')
    const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
    let match = re.exec(line)
    while (match) {
      for (const name of match[1].split(',')) {
        const trimmed = name.trim()
        if (trimmed) uses.push({ name: trimmed, line: index + 1 })
      }
      match = re.exec(line)
    }
  })
  return uses
}
```

and in `buildProjectIndex` collect `packages: PackageUse[]` by calling `scanPackages`
per `.tex` file (cached by content hash like environments) and filling each use's
`path`, then expose it on `ProjectIndex` as `packages`. The tool's `view=packages`
returns `{ documentClass: index.outline.documentClass, packages: index.packages }`.
Add a test asserting `view=packages` reports `graphicx` at `main.tex:2`.

- [ ] **Step 4: Update the registry and the tool card**

In `agent/tools/registry.ts`: remove the three imports and entries, add

```ts
import { projectMapTool } from './project-map'
...
export const TOOLS: Record<string, AgentTool> = {
  project_map: projectMapTool,
  read_file: readFileTool,
  search_project: searchProjectTool,
  edit_file: editFileTool,
  create_file: createFileTool,
  compile_project: compileProjectTool,
  get_compile_log: compileLogTool,
}
```

Seven entries, exactly: `project_map`, `read_file`, `search_project`, `edit_file`,
`create_file`, `compile_project`, `get_compile_log`. Remove the imports of the three
deleted tools in the same edit.

Delete the three tool files and their two test files.

In `components/agent/tool-call-card.tsx`: add a `project_map` case to `ToolIcon` (use `MapTrifold` or `ListBullets` from `@phosphor-icons/react`, matching the existing import style) and to `summarise`:

```ts
    case 'project_map': {
      const view = args.view ?? 'outline'
      const counts =
        view === 'files'
          ? Array.isArray(result?.files)
            ? result.files.length
            : 0
          : view === 'outline'
            ? Array.isArray(result?.sections)
              ? result.sections.length
              : 0
            : 0
      return {
        action: t('ai_assist_tool_project_map', 'Mapped project'),
        target: counts > 0 ? `${view}, ${counts}` : view,
      }
    }
```

and delete the `list_files`, `outline_project`, `list_references` cases.

- [ ] **Step 5: Run the new tests**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx --grep="project_map" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS, 7 (6 above plus the packages-location test).

- [ ] **Step 6: Run the module suite**

Expected: 456 − (tests deleted with the two old test files) + 7. Record the exact number you see; it must be 0 failing. If any surviving test referenced the deleted tools (e.g. a registry-shape assertion), update it in this task.

- [ ] **Step 7: Verify no commit**

---

## Task 4: `read_file section=`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts` (extend)

**Interfaces:**
- Consumes: `handle.index()` (Task 2), `matchSection` (Task 1).

- [ ] **Step 1: Write the failing tests**

Append to `read-tools.test.ts`. First check its imports: if it does not already
import `readFileTool` and `createFakeHandle`, add them —
`import { readFileTool } from '.../agent/tools/read-file'` and
`import { createFakeHandle } from './helpers/fake-handle'` — and destructure
`{ handle }` from the fake at each call site:

```ts
  it('reads a section by title through the index', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex':
          '\\section{Intro}\nfirst line\nsecond line\n\\section{Method}\nbody\n',
      },
      rootDoc: 'main.tex',
    })

    const result: any = await readFileTool.execute(
      { path: 'main.tex', section: 'intro' },
      handle
    )
    expect(result.from).to.equal(1)
    // The body range ends at the line before the next same-or-higher-level
    // heading: line 4 here, so the \section{Method} line is excluded.
    expect(result.to).to.equal(4)
    expect(result.content).to.contain('second line')
    expect(result.content).to.not.contain('body')
  })

  it('rejects from/to together with section', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\section{Intro}\nx\n' },
      rootDoc: 'main.tex',
    })
    const result: any = await readFileTool.execute(
      { path: 'main.tex', section: 'intro', from: 1 },
      handle
    )
    expect(result.error).to.be.a('string')
  })

  it('lists candidate titles when the section is ambiguous', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\section{Data}\nx\n\\section{Data Sets}\ny\n' },
      rootDoc: 'main.tex',
    })
    const result: any = await readFileTool.execute(
      { path: 'main.tex', section: 'data' },
      handle
    )
    expect(result.error).to.be.a('string')
    expect(result.candidates).to.have.length(2)
  })
```

- [ ] **Step 2: Run to see them fail** — Expected: FAIL (section ignored or unknown).

- [ ] **Step 3: Implement**

In `read-file.ts`, add `section` to the spec parameters:

```ts
        section: {
          type: 'string',
          description:
            'Read a whole section by title instead of a line range. Mutually exclusive with from/to.',
        },
```

and in `execute`, after the binary check:

```ts
    if (section && (from !== undefined || to !== undefined)) {
      return {
        error: 'Pass section or from/to, not both.',
      }
    }

    let rangeFrom = from
    let rangeTo = to

    if (section) {
      const index = await handle.index()
      const match = matchSection(index.outline, section)
      if (match.kind === 'none') {
        return {
          error: `No section matches "${section}" in this project.`,
          candidates: index.outline.sections.map(s => s.title),
        }
      }
      if (match.kind === 'ambiguous') {
        return {
          error: `"${section}" matches more than one section.`,
          candidates: match.candidates.map(c => c.title),
        }
      }
      const target = match.section
      if (target.path !== path) {
        return {
          error: `Section "${section}" lives in ${target.path}, not ${path}.`,
        }
      }
      const siblings = index.outline.sections
      const nextPeer = siblings
        .slice(siblings.indexOf(target) + 1)
        .find(candidate => candidate.level <= target.level)
      rangeFrom = target.line
      rangeTo = nextPeer ? nextPeer.line - 1 : undefined
    }
```

then use `rangeFrom`/`rangeTo` in place of `from`/`to` in the existing slicing code. Import `matchSection` from `../context/project-index`.

- [ ] **Step 4: Run the tests** — Expected: PASS, the 3 new plus all pre-existing read tests.

- [ ] **Step 5: Run the module suite** — Expected: previous count + 3, 0 failing.

- [ ] **Step 6: Verify no commit**

---

# Phase 3 — The slim envelope

## Task 5: Slim `<files>` block

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-context.ts`
- Test: `modules/ai-assist/test/frontend/js/context/project-context.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `project-context.test.ts`:

```ts
  it('renders a slim files block: root, counts and top-level dirs only', function () {
    const { text } = renderEnvelope({
      snapshot: {
        rootDocPath: 'main.tex',
        files: [
          { path: 'main.tex', type: 'doc', size: 10, lines: 2 },
          { path: 'sections/a.tex', type: 'doc', size: 10, lines: 2 },
          { path: 'sections/b.tex', type: 'doc', size: 10, lines: 2 },
          { path: 'refs.bib', type: 'doc', size: 10, lines: 2 },
          { path: 'figures/x.png', type: 'binary', size: 2048 },
          { path: 'figures/y.png', type: 'binary', size: 2048 },
        ],
        openFile: null,
        selection: null,
        compile: null,
      },
      attachments: [],
      turn: 1,
      previous: null,
    })

    expect(text).to.contain('<files root="main.tex" tex="3" bib="1" other="2">')
    expect(text).to.contain('sections/  2 tex')
    expect(text).to.contain('figures/  2 other')
    // The full listing must NOT be in the envelope any more.
    expect(text).to.not.contain('sections/a.tex')
  })

  it('still collapses to unchanged when the tree did not change', function () {
    const snapshot = {
      rootDocPath: 'main.tex',
      files: [{ path: 'main.tex', type: 'doc' as const, size: 10, lines: 2 }],
      openFile: null,
      selection: null,
      compile: null,
    }
    const first = renderEnvelope({
      snapshot,
      attachments: [],
      turn: 1,
      previous: null,
    })
    const second = renderEnvelope({
      snapshot,
      attachments: [],
      turn: 2,
      previous: first.state,
    })
    expect(second.text).to.contain('<files>unchanged since turn 1</files>')
  })
```

- [ ] **Step 2: Run to see them fail** — Expected: FAIL (full listing present).

- [ ] **Step 3: Implement**

Replace the body of `renderFiles` in `project-context.ts` (keep the fingerprint short-circuit exactly as it is) with:

```ts
  const docs = snapshot.files.filter(file => file.type === 'doc')
  const tex = docs.filter(file => file.path.endsWith('.tex')).length
  const bib = docs.filter(file => file.path.endsWith('.bib')).length
  const other = snapshot.files.length - tex - bib

  const dirs = new Map<string, { tex: number; other: number }>()
  for (const file of snapshot.files) {
    const slash = file.path.indexOf('/')
    const top = slash === -1 ? null : file.path.slice(0, slash + 1)
    if (!top) continue
    const entry = dirs.get(top) ?? { tex: 0, other: 0 }
    if (file.type === 'doc' && file.path.endsWith('.tex')) entry.tex += 1
    else entry.other += 1
    dirs.set(top, entry)
  }

  const rows = [...dirs.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, counts]) => {
      const parts = [
        counts.tex ? `${counts.tex} tex` : null,
        counts.other ? `${counts.other} other` : null,
      ].filter(Boolean)
      return `${neutraliseClosingTags(dir)}  ${parts.join(', ')}`
    })

  const open = snapshot.rootDocPath
    ? `<files root="${escapeAttribute(snapshot.rootDocPath)}" tex="${tex}" bib="${bib}" other="${other}">`
    : `<files tex="${tex}" bib="${bib}" other="${other}">`

  return {
    text: [open, ...rows, '</files>'].join('\n'),
    fingerprint,
  }
```

`MAX_LISTED_FILES` becomes unused in this file; leave the export in place if any test imports it, otherwise remove it in this task.

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Run the module suite** — Expected: previous + 2, 0 failing. Note: any pre-existing test asserting the old padded-listing rows must be updated here; read each before changing.

- [ ] **Step 6: Verify no commit**

---

# Phase 4 — Prompt and fallback

## Task 6: Prompt rewrite and tool descriptions

**Files:**
- Modify: `agent/context/system-prompt.ts` (full rewrite, this task only)
- Modify: descriptions in `agent/tools/project-map.ts` (already written in Task 3 — verify), `read-file.ts`, `search-project.ts`, `edit-file.ts`, `create-file.ts`, `compile-project.ts`, `compile-log.ts`
- Modify: `agent/fix-run.ts` (`FIX_TASK_BLOCK` tool list)
- Test: `modules/ai-assist/test/frontend/js/context/system-prompt.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `system-prompt.test.ts`:

```ts
  it('teaches the orientation ladder and names relative costs', function () {
    expect(SYSTEM_PROMPT).to.contain('project_map')
    expect(SYSTEM_PROMPT).to.contain('search_project')
    expect(SYSTEM_PROMPT).to.contain('read_file')
    // The ladder order must appear in the prompt in this order.
    expect(SYSTEM_PROMPT.indexOf('project_map')).to.be.lessThan(
      SYSTEM_PROMPT.indexOf('search_project')
    )
    expect(SYSTEM_PROMPT.indexOf('search_project')).to.be.lessThan(
      SYSTEM_PROMPT.indexOf('read_file')
    )
    // No stale tool names survive the rewrite.
    expect(SYSTEM_PROMPT).to.not.contain('outline_project')
    expect(SYSTEM_PROMPT).to.not.contain('list_references')
    expect(SYSTEM_PROMPT).to.not.contain('list_files')
  })

  it('stays a pure constant with no interpolated project data', function () {
    // Structural guarantee: the exported value is a string built only from
    // literals in this module.
    expect(SYSTEM_PROMPT).to.be.a('string')
    expect(SYSTEM_PROMPT).to.not.contain('<project-context')
  })
```

- [ ] **Step 2: Run to see it fail** — Expected: FAIL on the stale-name assertions.

- [ ] **Step 3: Rewrite `SYSTEM_PROMPT`**

Replace the whole exported constant with:

```ts
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
  'as it was when the user sent that message: a summary of the file tree, the',
  'last compile result, which file is open, the current selection, and anything',
  'the user attached. The newest block is the current one; earlier blocks are',
  'historical snapshots and may be stale. The block lists top-level directories',
  'and counts, not every path — ask project_map for the full listing when you',
  'need it.',
  '',
  '# Choosing a tool',
  '',
  'Climb the ladder in order; each rung is cheaper than the one below it.',
  '',
  '1. `project_map` — a few hundred tokens, answered from a prebuilt index.',
  '   `view=outline` for the section tree and line numbers (`section=` for one',
  '   subtree with its exact range); `view=references` for every \\label, \\ref',
  '   and \\cite with whether it resolves; `view=packages` for the',
  '   documentclass and every \\usepackage with the file that loads it;',
  '   `view=files` for the full listing (`glob=` to narrow). Use this first,',
  '   always, on an unfamiliar project. Never read files to answer a question',
  '   about structure, references or packages.',
  '2. `search_project` — find a string or pattern, with context lines. Use it',
  '   to locate anything the index does not cover, instead of guessing a path.',
  '3. `read_file` — read one file or a range. Prefer `section=` over line',
  '   ranges: it costs exactly the section and nothing else. A read costs',
  '   roughly 270 tokens per 1,000 characters, so read a section, not a file.',
  '4. `edit_file` — change a file. See the contract below.',
  '5. `create_file` — add a new file. It must not already exist.',
  '',
  'And two that are not on the ladder:',
  '',
  '- `get_compile_log` — the last build result without rebuilding. Prefer it',
  '  over compiling when you only need to see what already failed.',
  '- `compile_project` — build the project. See the compile policy below.',
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

Rewrite the other tool descriptions to "use when / not when" pairs:

- `read_file`: `'Read one text file, or part of one, as numbered lines. Use after project_map or search_project has told you where to look; prefer section= over line ranges. Not for finding where something is — that is search_project. Not for structure, references or packages — project_map answers those for a fraction of the cost.'`
- `search_project`: `'Find a string or regular expression across the text files, with context lines. Use to locate anything the index does not cover, instead of guessing a path. Not for structure or reference questions — project_map answers those without scanning.'`
- `edit_file`: keep its existing description and append `' Not for creating files — create_file does that.'`
- `create_file`: keep, append `' Not for editing — edit_file does that.'`
- `compile_project`: `'Build the project and report errors and warnings. Use after edits that could affect the build. Not to see what already failed — get_compile_log shows the last result without rebuilding.'`
- `get_compile_log`: `'The last build result without rebuilding: errors, warnings and raw log excerpts. Use whenever you need to see what already failed. Not a substitute for compiling after your own edits.'`

In `agent/fix-run.ts`, update `FIX_TASK_BLOCK` line 2 wording only if it names tools; verify and, if it does, replace the names with the five the fix run sends (`project_map`, `read_file`, `search_project`, `edit_file`, `get_compile_log`). `FIX_TOOLS` needs no change: it filters `TOOLS` by exclusion and now yields exactly those five.

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Run the module suite** — Expected: previous + 2, 0 failing.

- [ ] **Step 6: Verify no commit**

---

## Task 7: Text-tool-call rescue

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/text-tool-call.ts`
- Modify: `agent/run-agent.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/text-tool-call.test.ts` (create)

**Interfaces:**
- Produces: `extractFencedToolCall(pending: string, tools): { call: ToolCall; before: string; after: string } | null` and `parseWholeMessageToolCall(text: string, tools): ToolCall | null`.

**Design ruling (streaming honesty):** fenced ```json blocks are detected incrementally with a holdback, so they never reach the UI or the stored reply. A bare whole-message object (a model that emits only `{"name":...,"arguments":...}`) is detected at end of turn; its text may have streamed visibly, but the stored assistant message keeps the converted call and drops the raw JSON. One conversion per assistant turn, guardrailed in `run-agent`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect } from 'chai'
import {
  extractFencedToolCall,
  parseWholeMessageToolCall,
} from '../../../../frontend/js/features/ai-assist/agent/text-tool-call'

const TOOLS: any = {
  read_file: {
    spec: {
      name: 'read_file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
}

describe('extractFencedToolCall', function () {
  it('converts a complete fenced call and returns the surrounding text', function () {
    const pending = 'Let me look.\n```json\n{"name":"read_file","arguments":{"path":"main.tex"}}\n```\nDone.'
    const found = extractFencedToolCall(pending, TOOLS)
    expect(found).to.not.equal(null)
    expect(found!.call).to.deep.equal({
      id: 'text-1',
      name: 'read_file',
      args: { path: 'main.tex' },
    })
    expect(found!.before).to.equal('Let me look.\n')
    expect(found!.after).to.equal('\nDone.')
  })

  it('returns null while the fence is still open', function () {
    const pending = '```json\n{"name":"read_file","arguments":{"path":"'
    expect(extractFencedToolCall(pending, TOOLS)).to.equal(null)
  })

  it('leaves prose that merely mentions json alone', function () {
    const pending = 'The config looks like ```json\n{"name": "read_file"}\n``` but is not a call.'
    // No "arguments" object that validates against the spec: not a call.
    expect(extractFencedToolCall(pending, TOOLS)).to.equal(null)
  })

  it('leaves an unknown tool name as text', function () {
    const pending = '```json\n{"name":"vibes","arguments":{"path":"main.tex"}}\n```'
    expect(extractFencedToolCall(pending, TOOLS)).to.equal(null)
  })

  it('leaves invalid arguments as text', function () {
    const pending = '```json\n{"name":"read_file","arguments":{"nope":1}}\n```'
    expect(extractFencedToolCall(pending, TOOLS)).to.equal(null)
  })
})

describe('parseWholeMessageToolCall', function () {
  it('converts a message that is only a tool call object', function () {
    const call = parseWholeMessageToolCall(
      '{"name":"read_file","arguments":{"path":"main.tex"}}',
      TOOLS
    )
    expect(call).to.deep.equal({
      id: 'text-1',
      name: 'read_file',
      args: { path: 'main.tex' },
    })
  })

  it('returns null for a message that is prose', function () {
    expect(parseWholeMessageToolCall('I will read the file now.', TOOLS)).to.equal(null)
  })
})
```

- [ ] **Step 2: Run to see them fail** — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `text-tool-call.ts`**

```ts
import { ToolCall } from '../providers/types'
import { AgentTool } from './tools/registry'

const FENCE_OPEN = '```json'

function validate(
  parsed: any,
  tools: Record<string, AgentTool>
): ToolCall | null {
  if (typeof parsed?.name !== 'string') return null
  const tool = tools[parsed.name]
  if (!tool) return null
  const args = parsed.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return null
  }
  const required: string[] = tool.spec.parameters?.required ?? []
  for (const key of required) {
    if (!(key in args)) return null
  }
  const properties = tool.spec.parameters?.properties ?? {}
  for (const key of Object.keys(args)) {
    if (!(key in properties)) return null
  }
  return { id: 'text-1', name: parsed.name, args }
}

/**
 * Pulls one tool call out of streamed assistant text that a provider without
 * native tool support emitted as a fenced json block.
 *
 * Returns null while the fence is still open so the caller can hold the tail
 * back instead of flashing half a JSON blob at the user, and null for anything
 * that is not a valid call against the current registry — prose that quotes
 * JSON must stay prose.
 */
export function extractFencedToolCall(
  pending: string,
  tools: Record<string, AgentTool>
): { call: ToolCall; before: string; after: string } | null {
  const open = pending.indexOf(FENCE_OPEN)
  if (open === -1) return null

  const bodyStart = open + FENCE_OPEN.length
  const close = pending.indexOf('```', bodyStart)
  if (close === -1) return null

  let parsed: any
  try {
    parsed = JSON.parse(pending.slice(bodyStart, close).trim())
  } catch {
    return null
  }

  const call = validate(parsed, tools)
  if (!call) return null

  return {
    call,
    before: pending.slice(0, open),
    after: pending.slice(close + 3),
  }
}

/**
 * End-of-turn rescue for models that answer with nothing but a bare tool-call
 * object. The text may already have streamed; the stored message drops it.
 */
export function parseWholeMessageToolCall(
  text: string,
  tools: Record<string, AgentTool>
): ToolCall | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  let parsed: any
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  return validate(parsed, tools)
}
```

- [ ] **Step 4: Wire into `run-agent.ts`**

Inside the turn loop, add holdback state next to `inThinkTag`:

```ts
    let held = ''
    let convertedThisTurn = false
```

In the `chunk.type === 'text'` branch, after the `<think>` scanner produces a plain-text piece (the `text += raw; yield { type: 'text', text: raw }` path), route it through the detector instead of yielding directly:

```ts
                held += raw
                const found = convertedThisTurn
                  ? null
                  : extractFencedToolCall(held, tools)
                if (found) {
                  if (found.before) yield { type: 'text', text: found.before }
                  text += found.before
                  calls.push(found.call)
                  convertedThisTurn = true
                  held = found.after
                } else if (held.includes('```json') && !held.slice(held.indexOf('```json') + 7).includes('```')) {
                  // Fence open but not closed: yield what precedes it and hold
                  // the rest until the closing fence arrives.
                  const open = held.indexOf('```json')
                  if (open > 0) {
                    yield { type: 'text', text: held.slice(0, open) }
                    text += held.slice(0, open)
                  }
                  held = held.slice(open)
                } else {
                  yield { type: 'text', text: held }
                  text += held
                  held = ''
                }
                break
```

After the stream loop ends and before the `calls.length === 0` check, flush and run the whole-message rescue:

```ts
    if (held) {
      yield { type: 'text', text: held }
      text += held
      held = ''
    }

    if (calls.length === 0 && !convertedThisTurn) {
      const rescued = parseWholeMessageToolCall(text, tools)
      if (rescued) {
        calls.push(rescued)
        text = ''
      }
    }
```

- [ ] **Step 5: Run the new tests plus the run-agent suite**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx --grep="extractFencedToolCall|parseWholeMessageToolCall|runAgent" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS, including every pre-existing `runAgent` test — the holdback must not change behaviour for providers that stream plain prose.

- [ ] **Step 6: Run the module suite** — Expected: previous + 7, 0 failing.

- [ ] **Step 7: Verify no commit**

---

# Phase 5 — Verify

## Task 8: Full verification and dev server

- [ ] **Step 1: Typecheck**

```
cd overleaf/services/web
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "modules/ai-assist" | head -20
```

Expected: no output.

- [ ] **Step 2: Lint**

```
cd overleaf/services/web
npx eslint modules/ai-assist --ext .ts,.tsx 2>&1 | tail -20
```

Expected: no issues.

- [ ] **Step 3: Full frontend suite**

Expected: 0 failing; record the passing count against the running baseline.

- [ ] **Step 4: Unit suite**

```
cd overleaf/services/web
npx vitest run modules/ai-assist/test/unit 2>&1 | tail -10
```

Expected: PASS, including `CoreWiring.test.mjs` (the four slot paths and `apply-fix-listener.tsx` registration are unchanged by this plan).

- [ ] **Step 5: Redeploy the dev server**

Restart the `ai-assist` worktree stack (`web` + `webpack` with the three compose files, override last) and confirm the webpack build reports `compiled successfully` and the login page answers 200. Then check by hand: open a project with a `\input` graph, ask the rail "outline this paper", and confirm one `project_map` card appears with the section tree, and that a follow-up "read the method section" issues `read_file` with `section=`.

- [ ] **Step 6: Final state check**

```
git status --short
```

Expected: all work uncommitted. **No commit at any point in this plan.**

---

## Self-Review Notes

Checked against the spec:

- §1 index, ownership via `handle.index()`, `tooLarge`, memoization → Tasks 1–2. The spec's "per-file memoized parses reusing the parsers unchanged" was corrected during planning to the two honest units (whole-index identity short-circuit + per-file environment/package scan caches), because `parseOutline` and `extractReferences` are cross-file; the ruling is recorded in Task 1.
- §2 seven tools, `section=` reads, mutual exclusion, section matching rule → Tasks 3–4.
- §3 slim envelope with unchanged delta contract → Task 5.
- §4 prompt rewrite, tool descriptions, fix-block tool list, fallback with one-conversion-per-turn guardrail → Tasks 6–7.
- §5 tests → distributed per task; regression gates in Task 8.

Type consistency: `ProjectIndex`/`FileIndex`/`EnvironmentCount`/`PackageUse` defined in Task 1, consumed in Tasks 2–4. `matchSection` defined in Task 1, consumed in Tasks 3–4. `matchesGlob` exported from `search-project.ts` in Task 3, consumed by `project-map.ts`. `index()` added to `ProjectHandle` in Task 2, consumed in Tasks 3–4 and implemented in both the real and fake handles.
