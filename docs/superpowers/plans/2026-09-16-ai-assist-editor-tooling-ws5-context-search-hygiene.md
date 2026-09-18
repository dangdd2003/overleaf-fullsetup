# AI Assist Editor Tooling WS5: Context Indexing, Structural Search & Harness Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate false-negative searches caused by premature 50-hit project capping, align all agent tool schemas with runtime execution parameters (including `path` in `search_text`), capture package options (e.g., `[table]` for `xcolor`) and compiler engine info in `get_packages`, clamp `get_outline` line ranges to actual file boundaries, provide explicit file listings in `project-context` for small projects, generate unique deterministic monotonic tool call IDs to prevent provider wire collisions, relax aggressive consecutive loop aborts on diagnostic responses, and add comprehensive integration tests driving the real CodeMirror editor bridge and handle.

**Architecture:** 
1. **Search & Discovery Engine:** `ProjectHandle.search` and `use-project-handle.ts` accept an optional `glob` / `path` filter that is applied to project documents *before* running `SearchCursor` / `RegExpCursor`, ensuring the 50-hit limit applies strictly to relevant files. `search_text` tool specs and backend `AiAssistTools.mjs` expose `path` as an alias for `glob`. `text-tool-call.ts` is audited so all tools accept valid parameter signatures.
2. **Context & Indexing:** `scanPackages` in `project-index.ts` captures optional bracketed package options (`PackageUse.options`), which `get_packages` returns and renders alongside compiler engine and TeX Live image metadata retrieved via `handle.getProjectSettings()`. `get_outline` clamps section `end` lines to the file line count rather than emitting `Number.MAX_SAFE_INTEGER` and avoids misleading `to=end` hints. `renderFiles` in `project-context.ts` renders explicit file path listings when total files <= 50.
3. **Agent Loop & Wire Protocol:** Tool call IDs generated during text tool extraction (`text-tool-call.ts`) and fallback streaming (`run-agent.ts`) use a monotonic counter combined with timestamp and random salt (`call_txt_${Date.now()}_${++counter}_${salt}`), guaranteeing uniqueness across turns. In `run-agent.ts`, loop failure guards distinguish identical repeating loops (halted at 2) from distinct tool diagnostic attempts (threshold raised from 3 to 5).
4. **Integration Testing Harness:** Real CodeMirror 6 editor views and `ApplyFixListener` custom event channels are mounted in unit/integration tests (`use-project-handle.test.tsx` and `editor-bridge-integration.test.tsx`) to verify document reading, edit replacement, cursor/selection tracking, and file creation.

**Tech Stack:** TypeScript, React, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/search`), Node.js (ES modules `.mjs`), Mocha + Chai + Sinon (Frontend unit suite), Vitest (Backend unit suite).

**Spec:** `overleaf/docs/superpowers/specs/2026-09-16-ai-assist-editor-tooling-redesign-design.md`

---

## Global Constraints

- **Never run `git commit`, `git push`, or any history-altering git command.** This repository requires explicit per-command user approval for all git writes. Leave every change in the working tree. Verification steps replace commit steps. This overrides any instruction from a sub-skill telling you to commit after each task.
- **Working directory for all commands:** `overleaf/services/web` inside the `ai-assist` worktree:
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Frontend test runner** (mocha — note: NOT vitest):
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha \
    --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
    --require test/frontend/bootstrap.js \
    <path_to_test>
  ```
- **Backend test runner** (vitest, run from `overleaf/services/web`):
  ```bash
  NODE_ENV=test ../../node_modules/.bin/vitest run <path_to_test>
  ```
- **Baseline (verified 2026-09-16):**
  - Frontend (mocha): 774 passing, 0 failing.
  - Backend (vitest): 10 test files, 107 passing.
- **Engineered into tools and harness:** Fixes must never rely on prompt workarounds or retry instructions in system prompts.
- **No wrapper REST endpoints:** Do not create Overleaf backend REST wrappers for LLM provider APIs.
- **No instance default provider:** User supplies their own API key via the web UI.

---

## File Structure & Modified Files

| File | Role | Action |
| --- | --- | --- |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts` | ProjectHandle interface | Update `search` options signature (`glob?: string`) |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts` | CodeMirror ProjectHandle hook | Filter docs by glob before cursor search, cap matching hits only |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/search-text.ts` | Search tool definition | Add `path` parameter to schema, pass `glob` down to `handle.search` |
| `modules/ai-assist/app/src/AiAssistTools.mjs` | Backend tool definitions & execution | Add `path` to `search_text` schema and filter docs before searching |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-index.ts` | Project indexing & AST scanning | Add `options?: string` to `PackageUse`, update `scanPackages` regex |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-packages.ts` | Package inspection tool | Include package options and compiler settings in output & render |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-outline.ts` | Outline extraction tool | Bound `end` to actual line count, omit invalid `to=end` hints |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-context.ts` | Project context envelope renderer | List explicit file paths categorized by type when total files <= 50 |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/text-tool-call.ts` | Plain-text tool call parser | Generate unique monotonic IDs (`call_txt_...`) |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts` | Agent generator loop | Monotonic fallback tool IDs, raise `consecutiveFailures` threshold to 5 |
| `modules/ai-assist/test/frontend/js/agent/helpers/fake-handle.ts` | Test fake handle helper | Update fake `search` to support `glob` option |
| `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts` | Read/search tool test suite | New tests for glob pre-filtering & path parameter |
| `modules/ai-assist/test/frontend/js/agent/get-packages-tool.test.ts` | Package tool test suite | Tests for package options & compiler engine output |
| `modules/ai-assist/test/frontend/js/agent/get-outline-tool.test.ts` | Outline tool test suite | Tests for bounded line ranges on last sections |
| `modules/ai-assist/test/frontend/js/context/project-context.test.ts` | Context envelope test suite | Updated snapshot tests for explicit file listing |
| `modules/ai-assist/test/frontend/js/agent/text-tool-call.test.ts` | Text tool parser tests | Tests for unique dynamic tool call IDs |
| `modules/ai-assist/test/frontend/js/agent/use-project-handle.test.tsx` | Bridge integration test suite | Integration tests for real CodeMirror handle & bridge |

---

### Task 1: Fix `search_text` False Negatives with Glob Pre-Filtering and `path` Schema Parameter

**Problem:**
`use-project-handle.ts` iterates over all files in `projectSnapshot.docs` in arbitrary map order and breaks as soon as `hits.length < 50` is reached across the entire project. When `search-text.ts` executes, it passes no glob to `handle.search()` and attempts to filter hits *after* receiving the 50 project-wide hits. If earlier files contain 50 occurrences of common terms (e.g. `\section` or `\label`), searching a specific file returns 0 hits, causing false negatives. Furthermore, `search_text` spec in `search-text.ts` and `AiAssistTools.mjs` omits the `path` parameter, causing models that pass `path` instead of `glob` to be rejected by strict schema validation in `text-tool-call.ts`.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/search-text.ts`
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs`
- Modify: `modules/ai-assist/test/frontend/js/agent/helpers/fake-handle.ts`
- Modify: `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts`

- [ ] **Step 1: Update `project-handle.ts` interface**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts`, line 110:

Quote current code:
```ts
  search(
    query: string,
    options?: { caseSensitive?: boolean; regexp?: boolean }
  ): Promise<SearchHit[]>
```

Replace with:
```ts
  search(
    query: string,
    options?: {
      caseSensitive?: boolean
      regexp?: boolean
      glob?: string
    }
  ): Promise<SearchHit[]>
```

- [ ] **Step 2: Update `use-project-handle.ts` to filter files before searching**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`:
1. Add named import at top of file (around line 25):
```ts
import { matchesGlob } from './tools/search-text'
```
2. In `search` callback (around line 425), accept `glob?: string` in `options` and filter `Object.entries(docs)` before running the cursor loop.

Quote current code:
```ts
  const search = useCallback(
    async (
      query: string,
      options: { caseSensitive?: boolean; regexp?: boolean } = {}
    ): Promise<SearchHit[]> => {
      const docs = (projectSnapshot as any)?.docs ?? {}
      const hits: SearchHit[] = []

      for (const [path, doc] of Object.entries(docs)) {
        const lines = normalizeDoc((doc as any)?.doc?.lines ?? doc)
        const text = Text.of(lines)
```

Replace with:
```ts
  const search = useCallback(
    async (
      query: string,
      options: { caseSensitive?: boolean; regexp?: boolean; glob?: string } = {}
    ): Promise<SearchHit[]> => {
      const docs = (projectSnapshot as any)?.docs ?? {}
      const hits: SearchHit[] = []
      const globPattern = options.glob?.trim()

      for (const [rawPath, doc] of Object.entries(docs)) {
        const cleanPath = rawPath.replace(/^\//, '')
        if (globPattern && !matchesGlob(cleanPath, globPattern)) {
          continue
        }

        const lines = normalizeDoc((doc as any)?.doc?.lines ?? doc)
        const text = Text.of(lines)

        if (options.regexp) {
          try {
            const cursor = new RegExpCursor(
              text,
              query,
              { ignoreCase: !options.caseSensitive },
              0,
              text.length
            )
            while (!cursor.next().done && hits.length < 50) {
              const line = text.lineAt(cursor.value.from)
              hits.push({
                path: cleanPath,
                line: line.number,
                text: line.text,
              })
            }
          } catch {
            // fall back to string search on bad regex
          }
        } else {
          const cursor = new SearchCursor(
            text,
            query,
            0,
            text.length,
            options.caseSensitive ? s => s : s => s.toLowerCase()
          )
          while (!cursor.next().done && hits.length < 50) {
            const line = text.lineAt(cursor.value.from)
            hits.push({
              path: cleanPath,
              line: line.number,
              text: line.text,
            })
          }
        }

        if (hits.length >= 50) {
          break
        }
      }

      return hits
    },
    [projectSnapshot]
  )
```

- [ ] **Step 3: Update `search-text.ts` spec and execution**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/search-text.ts`:
1. Add `path` parameter to `spec.parameters.properties`.
2. Pass `glob: pattern` into `handle.search(query, { caseSensitive, regexp, glob: pattern })`.

Quote current code:
```ts
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        glob: {
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

  async execute(
    {
      query,
      glob,
      path: legacyPath,
      contextLines = 1,
      caseSensitive,
      regexp,
    }: {
      query: string
      glob?: string
      path?: string
      contextLines?: number
      caseSensitive?: boolean
      regexp?: boolean
    },
    handle
  ) {
    const pattern = glob ?? legacyPath
    const all = await handle.search(query, { caseSensitive, regexp })
    const filtered = pattern ? all.filter(hit => matchesGlob(hit.path, pattern)) : all
    const shown = filtered.slice(0, MAX_SEARCH_HITS)
```

Replace with:
```ts
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text or regex pattern to find' },
        glob: {
          type: 'string',
          description: 'Only search files matching this glob, e.g. sections/*.tex',
        },
        path: {
          type: 'string',
          description: 'Specific file path or glob pattern to search in (alias for glob)',
        },
        contextLines: {
          type: 'number',
          description: 'Lines of surrounding context per hit. Defaults to 1.',
        },
        caseSensitive: { type: 'boolean', description: 'Whether the search is case-sensitive' },
        regexp: { type: 'boolean', description: 'Whether query should be treated as a regular expression' },
      },
      required: ['query'],
    },
  },

  async execute(
    {
      query,
      glob,
      path: legacyPath,
      contextLines = 1,
      caseSensitive,
      regexp,
    }: {
      query: string
      glob?: string
      path?: string
      contextLines?: number
      caseSensitive?: boolean
      regexp?: boolean
    },
    handle
  ) {
    const pattern = glob ?? legacyPath
    const all = await handle.search(query, { caseSensitive, regexp, glob: pattern })
    const filtered = pattern ? all.filter(hit => matchesGlob(hit.path, pattern)) : all
    const shown = filtered.slice(0, MAX_SEARCH_HITS)
```

- [ ] **Step 4: Update backend `AiAssistTools.mjs`**

In `modules/ai-assist/app/src/AiAssistTools.mjs`:
1. In `executeTool` (lines 434-450), apply `args.glob || args.path` filter to `doc.path` before scanning lines.
2. In `getToolSpecs` (lines 1198-1205), add `path` to `search_text` parameter schema.

In `AiAssistTools.mjs` lines 434-450:
```js
      case 'search_text':
      case 'search_project': {
        const docs = await this._getDocsList(projectId)
        const targetPattern = args.glob || args.path
        const hits = []
        for (const doc of docs) {
          if (targetPattern) {
            const cleanPath = doc.path.replace(/^\//, '')
            const isMatch = targetPattern.includes('*')
              ? new RegExp('^' + targetPattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$').test(cleanPath)
              : cleanPath === targetPattern.replace(/^\//, '')
            if (!isMatch) continue
          }
          let lines = doc.lines
          try {
            const fetched = await this.docUpdater.getDocument(projectId, doc._id)
            if (fetched?.lines) lines = fetched.lines
          } catch {
            // keep fallback lines
          }
          lines.forEach((line, idx) => {
            if (line.includes(args.query)) {
              hits.push({ path: doc.path, line: idx + 1, text: line.trim() })
            }
          })
          if (hits.length >= 50) break
        }
        return { hits: hits.slice(0, 50) }
      }
```

In `AiAssistTools.mjs` lines 1198-1205:
```js
          properties: {
            query: { type: 'string', description: 'Search query or regex pattern' },
            glob: { type: 'string', description: 'Optional glob pattern to restrict file search scope' },
            path: { type: 'string', description: 'Optional file path or glob to restrict search scope (alias for glob)' },
            contextLines: { type: 'number', description: 'Number of context lines before and after match' },
            caseSensitive: { type: 'boolean', description: 'Whether the search is case-sensitive' },
            regexp: { type: 'boolean', description: 'Whether query should be treated as a regular expression' },
          },
```

- [ ] **Step 5: Update `fake-handle.ts` and `read-tools.test.ts`**

In `modules/ai-assist/test/frontend/js/agent/helpers/fake-handle.ts`:
1. Add import at top of file (around line 14):
```ts
import { matchesGlob } from '../../../../../frontend/js/features/ai-assist/agent/tools/search-text'
```
2. Update `search(query, options)`:
```ts
    async search(query, options) {
      calls.push({ name: 'search', args: { query, options } })
      const hits: SearchHit[] = []
      for (const [path, text] of Object.entries(docs)) {
        if (options?.glob && !matchesGlob(path, options.glob)) {
          continue
        }
        text.split('\n').forEach((line, index) => {
          if (line.includes(query)) hits.push({ path, line: index + 1, text: line })
        })
      }
      return hits
    },
```

In `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts`, add tests verifying:
1. `search_text` accepts `path` parameter and narrows search to that file.
2. `search_text` finds matches in a targeted file even when another file contains 60+ matches.
3. Update parameter vocabulary tests: verify `search_text` accepts `path` in addition to `glob`.

Run test command:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/read-tools.test.ts
```

---

### Task 2: Capture Package Options and Compiler Engine in `get_packages` & `project-index.ts`

**Problem:**
`scanPackages` in `project-index.ts` uses a regex that ignores optional bracketed arguments (`\usepackage[options]{package}`). Consequently, `PackageUse` has no `options` field. When an agent checks `get_packages`, it cannot tell whether a package like `xcolor` or `geometry` was already loaded with specific options (e.g. `[table]`), leading to duplicate package declarations and fatal LaTeX "Option clash for package" errors. Furthermore, `get_packages` does not surface the active LaTeX compiler engine or TeX Live image, which models need when choosing engine-compatible packages.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-index.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-packages.ts`
- Modify: `modules/ai-assist/test/frontend/js/agent/get-packages-tool.test.ts`

- [ ] **Step 1: Extend `PackageUse` type and update `scanPackages` in `project-index.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-index.ts`:
1. Line 35: Extend `PackageUse`:
```ts
export type PackageUse = {
  name: string
  options?: string
  path: string
  line: number
}
```

2. Lines 88-105: Update `scanPackages` to capture bracketed options:

Quote current code:
```ts
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

Replace with:
```ts
export function scanPackages(
  content: string
): Array<Omit<PackageUse, 'path'>> {
  const uses: Array<Omit<PackageUse, 'path'>> = []
  content.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/(?<!\\)%.*/, '')
    const re = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\\]*)\])?\s*\{([^}]*)\}/g
    let match = re.exec(line)
    while (match) {
      const options = match[1]?.trim() || undefined
      const pkgList = match[2]
      for (const name of pkgList.split(',')) {
        const trimmed = name.trim()
        if (trimmed) {
          uses.push({
            name: trimmed,
            ...(options ? { options } : {}),
            line: index + 1,
          })
        }
      }
      match = re.exec(line)
    }
  })
  return uses
}
```

- [ ] **Step 2: Update `get-packages.ts` to include compiler info and package options**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-packages.ts`:

Quote current code:
```ts
  async execute(_args = {}, handle) {
    const index = await handle.index()
    return {
      documentClass: index.outline.documentClass,
      packages: index.packages,
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)

    if (result.packages) {
      return [
        `documentclass: ${result.documentClass ?? 'unknown'}`,
        ...result.packages.map(
          (pkg: any) => `${pkg.name}  (${pkg.path}:${pkg.line})`
        ),
      ].join('\n')
    }

    return JSON.stringify(result)
  },
```

Replace with:
```ts
  async execute(_args = {}, handle) {
    const [index, settings] = await Promise.all([
      handle.index(),
      handle.getProjectSettings().catch(() => null),
    ])
    return {
      documentClass: index.outline.documentClass,
      compiler: settings?.compiler?.compiler ?? 'pdflatex',
      imageName: settings?.compiler?.imageName ?? null,
      packages: index.packages,
    }
  },

  render(result: any) {
    if (result?.error) return JSON.stringify(result)

    if (result.packages) {
      const header = [
        `documentclass: ${result.documentClass ?? 'unknown'}`,
        `compiler: ${result.compiler ?? 'unknown'}${result.imageName ? ` (${result.imageName})` : ''}`,
      ]
      const pkgLines = result.packages.map((pkg: any) => {
        const optStr = pkg.options ? ` [${pkg.options}]` : ''
        return `${pkg.name}${optStr}  (${pkg.path}:${pkg.line})`
      })
      return [...header, ...pkgLines].join('\n')
    }

    return JSON.stringify(result)
  },
```

- [ ] **Step 3: Update unit tests in `get-packages-tool.test.ts`**

In `modules/ai-assist/test/frontend/js/agent/get-packages-tool.test.ts`, add test cases:
1. Verify `get_packages` returns `options: 'table,dvipsnames'` for `\usepackage[table,dvipsnames]{xcolor}`.
2. Verify `get_packages` returns `compiler` and `imageName` from project settings.
3. Verify `render` formats options as `xcolor [table]  (main.tex:2)`.

Run test command:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/get-packages-tool.test.ts
```

---

### Task 3: Bound `get_outline` Section Ranges and Fix String Literal `to=end` Hint

**Problem:**
In `get-outline.ts` (lines 58-74), when a section has no following peer in the same file (`nextPeerInFile` is undefined), `end` defaults to `Number.MAX_SAFE_INTEGER`. Line 72 formats the hint string as: `read_file with path=... from=... to=end for the body`. Weak models parse the word "end" literally and call `read_file(path, from, to: 'end')`, failing JSON schema type validation because `to` must be a number. In addition, line ranges spanning beyond the document size confuse model line pagination.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-outline.ts`
- Modify: `modules/ai-assist/test/frontend/js/agent/get-outline-tool.test.ts`

- [ ] **Step 1: Update `get-outline.ts` to bound section line ranges**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-outline.ts`:

Quote current code:
```ts
    const target = match.section
    const siblings = index.outline.sections
    const startIndex = siblings.indexOf(target)
    const nextPeer = siblings
      .slice(startIndex + 1)
      .find(candidate => candidate.level <= target.level)
    const nextPeerInFile = siblings
      .slice(startIndex + 1)
      .find(
        candidate =>
          candidate.path === target.path && candidate.level <= target.level
      )
    const end = nextPeerInFile
      ? nextPeerInFile.line - 1
      : Number.MAX_SAFE_INTEGER
    const nextIndex = nextPeer ? siblings.indexOf(nextPeer) : siblings.length
    return {
      range: { from: target.line, to: end },
      sections: siblings.slice(startIndex, nextIndex),
      hint: `read_file with path=${target.path} from=${target.line} to=${
        end === Number.MAX_SAFE_INTEGER ? 'end' : end
      } for the body`,
    }
```

Replace with:
```ts
    const target = match.section
    const siblings = index.outline.sections
    const startIndex = siblings.indexOf(target)
    const nextPeer = siblings
      .slice(startIndex + 1)
      .find(candidate => candidate.level <= target.level)
    const nextPeerInFile = siblings
      .slice(startIndex + 1)
      .find(
        candidate =>
          candidate.path === target.path && candidate.level <= target.level
      )

    // Bound to file line count if no next peer in file
    let fileLines: number | undefined
    try {
      const fileEntry = (await handle.listFiles()).find(f => f.path === target.path)
      fileLines = fileEntry?.lines
    } catch {
      // ignore
    }

    const end = nextPeerInFile
      ? nextPeerInFile.line - 1
      : fileLines

    const nextIndex = nextPeer ? siblings.indexOf(nextPeer) : siblings.length
    const hint = end !== undefined
      ? `read_file with path=${target.path} from=${target.line} to=${end} for the body`
      : `read_file with path=${target.path} from=${target.line} for the body`

    return {
      range: { from: target.line, ...(end !== undefined ? { to: end } : {}) },
      sections: siblings.slice(startIndex, nextIndex),
      hint,
    }
```

- [ ] **Step 2: Update `get-outline-tool.test.ts`**

In `modules/ai-assist/test/frontend/js/agent/get-outline-tool.test.ts`, add assertions:
1. `result.range.to` on the final section in a file equals the file's line count, not `Number.MAX_SAFE_INTEGER`.
2. `result.hint` contains a numeric `to=` parameter and never literal `to=end`.

Run test command:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/get-outline-tool.test.ts
```

---

### Task 4: Explicit File Listing in `project-context.ts` for Projects <= 50 Files

**Problem:**
`project-context.ts` `renderFiles` aggregates all files into directory summary counts (`figures/ 1 other`, `sections/ 2 tex`). For standard projects (<= 50 files), the model never sees the actual file paths (such as `figures/diagram.png` or `chapters/intro.tex`) and is forced to spend a tool-call step on `list_files` or guess paths, causing `LaTeX Error: File not found`.

**TRAP:** `test/frontend/js/context/project-context.test.ts` contains snapshot tests for small fixtures (<=50 files). When updating `renderFiles`, multiple tests must be updated in the same step:
- `renders the slim file listing on the first turn` (lines 22-37): Expect `figures/plot.pdf [binary]` instead of directory row `figures/  1 other`.
- `renders the exact bytes of the envelope for the 3-file fixture` (lines 38-55): Expect `main.tex [tex]`, `refs.bib [bib]`, `figures/plot.pdf [binary]` instead of `figures/  1 other`.
- `re-emits the listing when a file appears` (lines 110-128): Expect `sections/intro.tex [tex]` instead of `sections/  1 tex`.
- `renders a slim files block: root, counts and top-level dirs only`: Adjust to verify explicit paths on small fixtures.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-context.ts`
- Modify: `modules/ai-assist/test/frontend/js/context/project-context.test.ts`

- [ ] **Step 1: Update `renderFiles` in `project-context.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-context.ts`:
When `snapshot.files.length <= 50`, render individual files grouped or listed with their types/extensions; when `> 50`, fall back to directory aggregation.

Quote current code (lines 20-58):
```ts
function renderFiles(snapshot: ContextSnapshot, previous: EnvelopeState | null) {
  const fingerprint = fingerprintFiles(snapshot.files)

  if (previous && previous.filesFingerprint === fingerprint) {
    return {
      text: `<files>unchanged since turn ${previous.turn}</files>`,
      fingerprint,
    }
  }

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
}
```

Replace with:
```ts
const MAX_EXPLICIT_FILES = 50

function renderFiles(snapshot: ContextSnapshot, previous: EnvelopeState | null) {
  const fingerprint = fingerprintFiles(snapshot.files)

  if (previous && previous.filesFingerprint === fingerprint) {
    return {
      text: `<files>unchanged since turn ${previous.turn}</files>`,
      fingerprint,
    }
  }

  const docs = snapshot.files.filter(file => file.type === 'doc')
  const tex = docs.filter(file => file.path.endsWith('.tex')).length
  const bib = docs.filter(file => file.path.endsWith('.bib')).length
  const other = snapshot.files.length - tex - bib

  const open = snapshot.rootDocPath
    ? `<files root="${escapeAttribute(snapshot.rootDocPath)}" tex="${tex}" bib="${bib}" other="${other}">`
    : `<files tex="${tex}" bib="${bib}" other="${other}">`

  // For small projects (<= 50 files), list explicit file paths so the model knows what files exist
  if (snapshot.files.length <= MAX_EXPLICIT_FILES) {
    const rows = snapshot.files
      .map(file => {
        const safePath = neutraliseClosingTags(file.path)
        const tag = file.type === 'binary' ? 'binary' : file.path.endsWith('.tex') ? 'tex' : file.path.endsWith('.bib') ? 'bib' : 'doc'
        return `${safePath} [${tag}]`
      })
    return {
      text: [open, ...rows, '</files>'].join('\n'),
      fingerprint,
    }
  }

  // Fallback for large projects (> 50 files): aggregate by top-level directory
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

  return {
    text: [open, ...rows, '</files>'].join('\n'),
    fingerprint,
  }
}
```

- [ ] **Step 2: Update `project-context.test.ts` contract expectations**

In `modules/ai-assist/test/frontend/js/context/project-context.test.ts`:
Update the tests asserting on the 3-file fixture and large projects:
1. `renders the slim file listing on the first turn` (lines 22-37): Expect `figures/plot.pdf [binary]` instead of `figures/  1 other`.
2. `renders the exact bytes of the envelope for the 3-file fixture` (lines 38-55): Expect `main.tex [tex]`, `refs.bib [bib]`, `figures/plot.pdf [binary]` instead of directory rows.
3. `re-emits the listing when a file appears` (lines 110-128): Expect `sections/intro.tex [tex]` instead of `sections/  1 tex`.
4. `summarises large projects into counts without listing files`: Ensure projects with 205 files continue to output `chapters/  205 tex`.
5. `renders a slim files block: root, counts and top-level dirs only`: Rename or adjust test to verify that projects with <= 50 files include explicit paths like `sections/a.tex [tex]`.

Run test command:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/project-context.test.ts
```

---

### Task 5: Deterministic Unique Tool Call IDs and Resilient Loop Failure Thresholds

**Problem:**
1. In `text-tool-call.ts` (line 31), parsed plain-text tool calls are assigned a static ID `id: 'text-1'`. In `run-agent.ts` (lines 149, 273), fallback IDs use `Date.now()` without a monotonic counter or unique salt. When multiple tool calls occur within the same millisecond or across turns, IDs collide, breaking OpenAI and Anthropic API message-tool validation.
2. In `run-agent.ts` (lines 231-258), `consecutiveFailures >= 3` halts the run prematurely when a model receives diagnostic feedback from a tool (such as `noMatch` or `ambiguous`) and attempts valid distinct recovery queries.

**TRAP:** `test/frontend/js/agent/run-agent.test.ts` (lines 653-717) tests `consecutiveToolFailures` with 3 turns and asserts `expect(consecutiveError.message).to.match(/3 consecutive failed/i)`. Raising the threshold to 5 requires updating the test setup to 5 failing turns and the expected message to match `/5 consecutive failed/i`.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/text-tool-call.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts`
- Modify: `modules/ai-assist/test/frontend/js/agent/text-tool-call.test.ts`
- Modify: `modules/ai-assist/test/frontend/js/agent/run-agent.test.ts`

- [ ] **Step 1: Implement Monotonic Unique Tool Call ID in `text-tool-call.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/text-tool-call.ts`:
Add a monotonic counter and unique generator:

```ts
let callCounter = 0

export function nextToolCallId(prefix = 'call_txt'): string {
  callCounter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now()}_${callCounter}_${rand}`
}
```

In `validate(parsed, tools)`, replace `id: 'text-1'` with `id: nextToolCallId()`.

- [ ] **Step 2: Update `run-agent.ts` Tool ID Generation and Failure Threshold**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts`:
1. Lines 15-18: Import `nextToolCallId` from `./text-tool-call`:
```ts
import {
  extractFencedToolCall,
  nextToolCallId,
  parseWholeMessageToolCall,
} from './text-tool-call'
```
2. Line 149: Replace `chunk.id || \`call_\${Date.now()}_\${calls.length}\`` with:
```ts
const id = chunk.id || nextToolCallId('call')
```
3. Line 273: Replace `toolCallId: call.id || \`call_\${Date.now()}\`` with `toolCallId: call.id || nextToolCallId('call')`.
4. Lines 245-258: Update consecutive failure threshold from 3 to 5 for non-identical failures, while preserving `identicalFailedCount >= 2` runaway loop protection:

Quote current code:
```ts
        if (identicalFailedCount >= 2) {
          yield {
            type: 'error',
            code: 'runawayToolLoop',
            message: `Stopped repeated failing call to ${call.name}. Please check the file contents or provide more specific instructions.`,
          }
          return yield { type: 'turnFinished', reason: 'stop' }
        }

        if (consecutiveFailures >= 3) {
          yield {
            type: 'error',
            code: 'consecutiveToolFailures',
            message: `Stopped after ${consecutiveFailures} consecutive failed tool operations. Please check the file contents or provide more specific instructions.`,
          }
          return yield { type: 'turnFinished', reason: 'stop' }
        }
```

Replace with:
```ts
        if (identicalFailedCount >= 2) {
          yield {
            type: 'error',
            code: 'runawayToolLoop',
            message: `Stopped repeated failing call to ${call.name}. Please check the file contents or provide more specific instructions.`,
          }
          return yield { type: 'turnFinished', reason: 'stop' }
        }

        if (consecutiveFailures >= 5) {
          yield {
            type: 'error',
            code: 'consecutiveToolFailures',
            message: `Stopped after ${consecutiveFailures} consecutive failed tool operations. Please check the file contents or provide more specific instructions.`,
          }
          return yield { type: 'turnFinished', reason: 'stop' }
        }
```

- [ ] **Step 3: Update `text-tool-call.test.ts` and `run-agent.test.ts`**

In `modules/ai-assist/test/frontend/js/agent/text-tool-call.test.ts`:
Update expected `call.id` to match regex `^call_txt_`:
```ts
    expect(found!.call.id).to.match(/^call_txt_/)
    expect(found!.call.name).to.equal('read_file')
    expect(found!.call.args).to.deep.equal({ path: 'main.tex' })
```

In `modules/ai-assist/test/frontend/js/agent/run-agent.test.ts`:
Update test `stops with consecutiveToolFailures after 3 consecutive failures` (rename to `stops with consecutiveToolFailures after 5 consecutive failures`):
1. Expand `turns` array to include 5 consecutive failing tool call turns (`c1` through `c5`).
2. Update assertion to expect 5 consecutive failed:
```ts
    expect(consecutiveError.message).to.match(/5 consecutive failed/i)
```

Run test command:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/text-tool-call.test.ts modules/ai-assist/test/frontend/js/agent/run-agent.test.ts
```

---

### Task 6: Add End-to-End Integration Tests for Real `useProjectHandle` and CodeMirror Bridge

**Problem:**
All existing tool tests use `createFakeHandle`. The real CodeMirror 6 bridge (`use-project-handle.ts` and `apply-fix-listener.tsx`) communicating over `window` CustomEvents (`aiAssist:agentApplyEdit`, `aiAssist:agentReadDoc`, `aiAssist:selectionChanged`) had zero automated test coverage, allowing bridge regressions to reach production.

**TRAP 1:** `ApplyFixListener` is a default export (`export default function ApplyFixListener()`). Use `import ApplyFixListener from ...`, NOT named import `{ ApplyFixListener }`.
**TRAP 2:** `ApplyFixListener` gates execution on `Boolean(getMeta('ol-aiAssistEnabled'))`. In the test environment, `getMeta` returns `undefined` by default unless seeded. In test `beforeEach`, set `window.metaAttributesCache = new Map([['ol-aiAssistEnabled', true as any]])` (and clear in `afterEach`), otherwise `ApplyFixListener` renders `null` and attaches zero event listeners.

**Files:**
- Create: `modules/ai-assist/test/frontend/js/agent/use-project-handle.test.tsx`

- [ ] **Step 1: Write integration test suite `use-project-handle.test.tsx`**

In `modules/ai-assist/test/frontend/js/agent/use-project-handle.test.tsx`:
Mount a real CodeMirror 6 `EditorView` with `ApplyFixListener` and `useProjectHandle` within a test container, verifying:
1. `handle.readFile(path)` dispatches and receives document text from active CodeMirror editor.
2. `handle.proposeEdit(edit)` dispatches `aiAssist:agentApplyEdit`, updates CodeMirror document text, and returns `status: 'applied'`.
3. `handle.proposeEdit(edit)` detects content divergence and returns `status: 'drifted'` without corrupting editor content.
4. `handle.search(query, { glob })` correctly scans CodeMirror state documents with glob filtering.
5. Selection changes in CodeMirror fire `aiAssist:selectionChanged` and update `handle.currentSelection()`.

Test file template:
```tsx
import { expect } from 'chai'
import React from 'react'
import { render, act } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import ApplyFixListener from '../../../../frontend/js/features/ai-assist/components/apply-fix-listener'
import { CodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { EditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'

describe('useProjectHandle & CodeMirror Bridge Integration', function () {
  let container: HTMLDivElement
  let view: EditorView

  beforeEach(function () {
    window.metaAttributesCache = new Map([
      ['ol-aiAssistEnabled', true as any],
    ])
    container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      doc: '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}',
    })
    view = new EditorView({ state, parent: container })
  })

  afterEach(function () {
    view.destroy()
    container.remove()
    window.metaAttributesCache = new Map()
  })

  it('handles aiAssist:agentApplyEdit and updates CodeMirror view', async function () {
    render(
      <CodeMirrorViewContext.Provider value={view}>
        <EditorOpenDocContext.Provider value={{ openDocName: 'main.tex', openDocId: 'doc-1' } as any}>
          <ApplyFixListener />
        </EditorOpenDocContext.Provider>
      </CodeMirrorViewContext.Provider>
    )

    let resultStatus: string | null = null
    const onResult = (e: Event) => {
      resultStatus = (e as CustomEvent).detail?.status
    }
    window.addEventListener('aiAssist:agentApplyEditResult', onResult)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentApplyEdit', {
          detail: {
            from: 3,
            to: 3,
            oldText: 'Hello World',
            replacement: 'Hello Overleaf',
          },
        })
      )
    })

    expect(resultStatus).to.equal('applied')
    expect(view.state.doc.toString()).to.include('Hello Overleaf')
    window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
  })

  it('rejects drifted edit when text does not match oldText', async function () {
    render(
      <CodeMirrorViewContext.Provider value={view}>
        <EditorOpenDocContext.Provider value={{ openDocName: 'main.tex', openDocId: 'doc-1' } as any}>
          <ApplyFixListener />
        </EditorOpenDocContext.Provider>
      </CodeMirrorViewContext.Provider>
    )

    let resultStatus: string | null = null
    const onResult = (e: Event) => {
      resultStatus = (e as CustomEvent).detail?.status
    }
    window.addEventListener('aiAssist:agentApplyEditResult', onResult)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentApplyEdit', {
          detail: {
            from: 3,
            to: 3,
            oldText: 'Mismatch Text',
            replacement: 'Hello Overleaf',
          },
        })
      )
    })

    expect(resultStatus).to.equal('drifted')
    expect(view.state.doc.toString()).to.include('Hello World')
    window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
  })
})
```

- [ ] **Step 2: Run new integration test suite**

Run command:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/use-project-handle.test.tsx
```

---

## Out of Scope

- Workstream 1: Editor Bridge document switching and off-screen file writes (`ide.fileTreeManager`).
- Workstream 2: Precision anchor fuzzy matching and line-range replacement.
- Workstream 3: LaTeX token parsing, bracket normalization, and delete primitives.
- Workstream 4: Compiler log delta analysis, error deduplication, and `get_compile_log` removal.

---

## Verification & Baseline Commands

Run full frontend and backend suites to verify zero regressions:

1. **Frontend Mocha Test Suite:**
   ```bash
   NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend
   ```
   *Expected:* >= 774 passing, 0 failing.

2. **Backend Vitest Test Suite:**
   ```bash
   NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
   ```
   *Expected:* 10 test files, >= 107 passing.
