# AI Assist Harness WS3: Server Tool & Prompt Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the main AI chat, which runs on the server, the same working tools and system prompt the in-browser agent already has, so the model stops reasoning from empty placeholder results.

**Architecture:** The main chat's tools run in `modules/ai-assist/app/src/AiAssistTools.mjs`. Several are placeholders or ignore their parameters. This plan ports the browser's pure LaTeX parsers (`agent/context/outline.ts`, `references.ts`, `project-index.ts`) to one server module. Parity tests import the TypeScript originals directly: Vitest can load them, which was verified on 2026-09-17. On top of that come a short-lived per-project snapshot (one flush + one bulk read instead of one request per document), real `get_outline`/`get_packages`/`get_references`, a `list_files` with globs and binary files, a `search_text` that honours case/regex/glob/context (regex runs in a worker thread with a timeout), a numbered and capped `read_file`, compact text rendering of tool results for the model, the full system prompt, and concurrent execution of read-only tool calls.

**Tech Stack:** Node.js ES modules (`.mjs`), `node:worker_threads`, Vitest + Chai + Sinon (Vitest can import `.ts` files, which the parity tests rely on).

**Spec:** None. This plan comes from a code review of the `ai-assist` module done on 2026-09-17. The "Background" section records the verified findings.

## Global Constraints

- **Never run `git commit`, `git push`, `git stash`, or any history-altering git command.** Leave every change uncommitted. Each task ends with a verification step, not a commit step. This overrides any sub-skill instruction to commit.
- **Implement WS1 and WS2 first.** They are `2026-09-17-ai-assist-harness-ws1-run-stream-reliability.md` and `2026-09-17-ai-assist-harness-ws2-agent-loop-correctness.md`. Tasks 5 and 7 here edit code WS2 changed (the tool-message push and the `edit_file` branch).
- **Another session may be editing this worktree at the same time.** Line numbers were verified on 2026-09-17. If a quoted "current code" block does not match, re-read the file and apply the change to the equivalent code. Never overwrite unrelated edits.
- **Do not touch the in-browser agent** (`frontend/js/features/ai-assist/agent/**`, `use-project-handle.ts`, `apply-fix-listener.tsx`). The browser files are the reference implementation here: read and import them in tests, never edit them. Browser editing is owned by the `2026-09-16-ai-assist-editor-tooling-ws1..ws5` plans.
- **Do not fix model behaviour by writing workaround instructions into prompts.** Task 6 copies the existing browser prompt verbatim. It does not add new instructions.
- **Working directory for all commands:**
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Backend test runner (Vitest, npx-cached binary; `XDG_DATA_HOME` is required):**
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run <path>
  ```
- **Frontend test runner (Mocha), only for the final check:**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' --reporter dot modules/ai-assist/test/frontend 2>&1 | grep -E "passing|failing"
  ```
- **Baseline before Task 1:** run the full backend module suite and record the counts:
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src 2>&1 | grep -E "Test Files|Tests "
  ```
- **Keep output small.** Grep test output for `Tests |×|FAIL|Error`.
- **Style:** 2-space indentation, single quotes, no semicolons.

## Background (verified findings this plan fixes)

The main chat is `AiAssistRunManager.startRun`. Its tools are `AiAssistTools.execute`, and its prompt is `DEFAULT_SYSTEM_PROMPT` (`AiAssistRunManager.mjs:7-10`). The in-browser agent (the compile-error fix panel) uses `frontend/js/features/ai-assist/agent/tools/*.ts` and `agent/context/system-prompt.ts`. Findings:

1. **Placeholder index tools.** `get_outline` always returns `sections: []`, `get_packages` always returns `packages: []`, and `get_references` always returns `references: []` (`AiAssistTools.mjs:769-781`). The model concludes that a project has no sections, packages, or labels.
2. **`search_text` ignores its parameters.** Its spec advertises `glob`, `contextLines`, `caseSensitive`, and `regexp`, but the implementation (`AiAssistTools.mjs:463-482`) is `line.includes(args.query)`: case-sensitive, never regex, no glob, no context.
3. **`list_files` ignores `glob` and omits binary files** (`AiAssistTools.mjs:484-493`), so the model cannot see images when fixing `\includegraphics`.
4. **`read_file` is uncapped and unnumbered.** Its spec says "as numbered lines", but it returns raw text (`AiAssistTools.mjs:440-461`) with no line cap. The browser version caps at 1000 lines and returns `nextRange`.
5. **One request per document.** `search_text`, `resolveEditTarget`, and the edit fallback call `docUpdater.getDocument` sequentially for every document on every call.
6. **Tool results are sent to the model as raw JSON** (`JSON.stringify(result)`). The browser renders file content as fenced text, which costs about a third fewer tokens and is quoted back more accurately (`agent/tools/registry.ts:33-42`).
7. **Four-line system prompt.** The server uses a four-line prompt. The browser prompt (`agent/context/system-prompt.ts`, 133 lines) is constant on purpose and holds the edit contract, the tool ladder, and the rules for insertion, compiling, and honesty. The project-context envelope already reaches the server through `contextText` on user entries (`agent-panel.tsx:108-122` → `AiAssistRunManager.toAgentMessages`), so only the prompt is missing.
8. **Read-only calls run one at a time.** When a model asks for several reads in one turn, they run sequentially (`AiAssistRunManager.mjs:356`).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `modules/ai-assist/app/src/AiAssistProjectIndex.mjs` | Create | Server port of `outline.ts`, `references.ts`, `project-index.ts` (pure functions). |
| `modules/ai-assist/app/src/AiAssistGlob.mjs` | Create | `matchesGlob`, a port of `search-text.ts:matchesGlob`. |
| `modules/ai-assist/app/src/AiAssistRegexSearch.mjs` | Create | Regex search in a worker thread with a timeout. |
| `modules/ai-assist/app/src/AiAssistToolRender.mjs` | Create | Compact text rendering of tool results for the model. |
| `modules/ai-assist/app/src/AiAssistSystemPrompt.mjs` | Create | Verbatim copy of the browser `SYSTEM_PROMPT`. |
| `modules/ai-assist/app/src/AiAssistTools.mjs` | Modify | Snapshot, real index tools, list/search/read parity, specs. |
| `modules/ai-assist/app/src/AiAssistRunManager.mjs` | Modify | Use the system prompt, render results, run leading read-only calls concurrently. |
| `modules/ai-assist/test/unit/src/AiAssistProjectIndex.test.mjs` | Create | Parity tests against the TypeScript originals. |
| `modules/ai-assist/test/unit/src/AiAssistRegexSearch.test.mjs` | Create | Worker search tests. |
| `modules/ai-assist/test/unit/src/AiAssistToolRender.test.mjs` | Create | Render tests. |
| `modules/ai-assist/test/unit/src/AiAssistSystemPrompt.test.mjs` | Create | Prompt parity test. |
| `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs` | Modify | Tool behaviour tests. |
| `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs` | Modify | Prompt, rendering, concurrency tests. |

---

### Task 1: Port the LaTeX project index to the server

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistProjectIndex.mjs`
- Create: `modules/ai-assist/test/unit/src/AiAssistProjectIndex.test.mjs`

**Interfaces:**
- Produces (all named exports): `readBraceGroup(text, openIndex)`, `parseOutline({ docs, rootPath })`, `extractReferences({ docs })`, `hasThebibliographyEnvironment({ docs })`, `hashContent(content)`, `scanEnvironments(content)`, `scanPackages(content)`, `buildProjectIndex({ docs, rootPath }, previous?)`, `normaliseSectionTitle(title)`, `matchSection(outline, query)`, `MAX_INDEXED_BYTES`. `docs` is `Record<path, string>`, with paths that have no leading slash. The return shapes are identical to the TypeScript originals.

- [x] **Step 1: Write the parity test**

Create `modules/ai-assist/test/unit/src/AiAssistProjectIndex.test.mjs`:

```js
import { expect } from 'chai'
import * as server from '../../../app/src/AiAssistProjectIndex.mjs'
// Vitest loads TypeScript directly. These are the browser originals the server
// port must match byte for byte.
import * as browserIndex from '../../../frontend/js/features/ai-assist/agent/context/project-index.ts'
import * as browserOutline from '../../../frontend/js/features/ai-assist/agent/context/outline.ts'
import * as browserRefs from '../../../frontend/js/features/ai-assist/agent/context/references.ts'

const PROJECT = {
  rootPath: 'main.tex',
  docs: {
    'main.tex': [
      '\\documentclass[11pt]{article}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{amsmath, graphicx}',
      '\\RequirePackage{hyperref}',
      '% \\usepackage{commentedout}',
      '\\title{A \\textbf{Bold} Paper}',
      '\\begin{document}',
      '\\section{Introduction}\\label{sec:intro}',
      'See \\ref{sec:method} and \\eqref{eq:one} and \\cite{knuth84, missing99}.',
      '\\input{sections/method}',
      '\\include{sections/missing}',
      '\\section*{Acknowledgements \\emph{(thanks)}}',
      '\\begin{figure}[h]\\end{figure}',
      '\\begin{equation*}x\\end{equation*}',
      '\\section{Broken {title',
      '\\end{document}',
    ].join('\n'),
    'sections/method.tex': [
      '\\section{Method}\\label{sec:method}',
      '\\subsection{Setup}',
      '\\begin{equation}\\label{eq:one}a=b\\end{equation}',
      '\\label{sec:intro}',
      '\\begin{table}\\end{table}',
      '\\citep[p.~3]{knuth84}',
      '50\\% of \\ref{undefined:key}',
    ].join('\n'),
    'refs.bib': ['@book{knuth84,', '  title={TAOCP}', '}', '@article{ other , x}'].join('\n'),
    'appendix.tex': [
      '\\chapter{Appendix}',
      '\\begin{thebibliography}{9}\\end{thebibliography}',
      '\\paragraph{Notes}',
    ].join('\n'),
  },
}

describe('AiAssistProjectIndex (server port)', function () {
  it('builds the same project index as the browser', function () {
    const expected = browserIndex.buildProjectIndex(PROJECT)
    const actual = server.buildProjectIndex(PROJECT)
    expect(JSON.stringify(actual)).to.equal(JSON.stringify(expected))
  })

  it('builds the same index when there is no root path', function () {
    const input = { docs: PROJECT.docs, rootPath: null }
    expect(JSON.stringify(server.buildProjectIndex(input))).to.equal(
      JSON.stringify(browserIndex.buildProjectIndex(input))
    )
  })

  it('parses outlines and references identically', function () {
    expect(JSON.stringify(server.parseOutline(PROJECT))).to.equal(
      JSON.stringify(browserOutline.parseOutline(PROJECT))
    )
    expect(JSON.stringify(server.extractReferences(PROJECT))).to.equal(
      JSON.stringify(browserRefs.extractReferences(PROJECT))
    )
  })

  it('matches sections identically', function () {
    const outline = browserOutline.parseOutline(PROJECT)
    for (const query of ['Introduction', 'intro', 'method', 'Setup', 'Acknowledgements', 'nothing', '', 'A']) {
      expect(
        JSON.stringify(server.matchSection(outline, query)),
        `matchSection(${JSON.stringify(query)})`
      ).to.equal(JSON.stringify(browserIndex.matchSection(outline, query)))
    }
  })

  it('reuses the previous index when nothing changed', function () {
    const first = server.buildProjectIndex(PROJECT)
    const second = server.buildProjectIndex(PROJECT, first)
    expect(second).to.equal(first)
  })

  it('skips files above MAX_INDEXED_BYTES like the browser', function () {
    const big = { rootPath: null, docs: { 'big.tex': '\\usepackage{x}\n' + 'a'.repeat(server.MAX_INDEXED_BYTES + 1) } }
    expect(JSON.stringify(server.buildProjectIndex(big))).to.equal(
      JSON.stringify(browserIndex.buildProjectIndex(big))
    )
  })
})
```

- [x] **Step 2: Run to verify it fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistProjectIndex.test.mjs 2>&1 | grep -E "Tests |FAIL|Error" | head -5
```
Expected: FAIL (`AiAssistProjectIndex.mjs` cannot be resolved).

- [x] **Step 3: Create the server port**

Create `modules/ai-assist/app/src/AiAssistProjectIndex.mjs`. This is the three TypeScript files with type annotations removed and nothing else changed:

```js
/**
 * Server port of the browser's project index:
 * frontend/js/features/ai-assist/agent/context/{outline,references,project-index}.ts
 *
 * Pure functions, no I/O. AiAssistProjectIndex.test.mjs imports the TypeScript
 * originals and asserts identical output, so change both or neither.
 */

// ---- outline.ts ----

const LEVELS = {
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
const TITLE_RE = /\\title\s*(?:\[[^\]]*\])?\s*\{/
const PACKAGE_RE = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g

/** Strips a line comment, respecting an escaped percent sign. */
function uncomment(line) {
  const index = line.search(/(?<!\\)%/)
  return index === -1 ? line : line.slice(0, index)
}

export function readBraceGroup(text, openIndex) {
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

function resolveInclude(target, docs) {
  const candidates = [target, `${target}.tex`, target.replace(/\.tex$/, '')]
  const hit = candidates.find(candidate => candidate in docs)
  return hit ?? (target.endsWith('.tex') ? target : `${target}.tex`)
}

export function parseOutline({ docs, rootPath }) {
  const sections = []
  const includes = []
  const packages = []
  const notes = []
  let documentClass = null
  let hasTitle = false

  const order =
    rootPath && rootPath in docs
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

      if (!hasTitle && TITLE_RE.test(line)) hasTitle = true

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

  return { documentClass, packages, sections, includes, notes, hasTitle }
}

// ---- references.ts ----

const LABEL_RE = /\\label\s*\{([^}]*)\}/g
const REF_RE = /\\(ref|eqref|autoref|cref|Cref|pageref)\s*\{([^}]*)\}/g
const CITE_RE =
  /\\(cite|citep|citet|citeauthor|citeyear|nocite)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
const BIB_ENTRY_RE = /^\s*@\w+\s*\{\s*([^,\s}]+)\s*,/
const THEBIB_RE = /\\begin\{thebibliography\}/

function keysOf(group) {
  return group
    .split(',')
    .map(key => key.trim())
    .filter(Boolean)
}

export function hasThebibliographyEnvironment({ docs }) {
  return Object.values(docs).some(content => THEBIB_RE.test(content))
}

export function extractReferences({ docs }) {
  const labels = []
  const bibKeys = []
  const rawRefs = []
  const rawCitations = []

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

  const seen = new Set()
  const duplicateLabels = []
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

// ---- project-index.ts ----

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
  'abstract',
]

/** djb2 with a length prefix: deterministic, cheap, collision-irrelevant here. */
export function hashContent(content) {
  let h = 5381
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0
  }
  return `${content.length}:${(h >>> 0).toString(16)}`
}

export function scanEnvironments(content) {
  const found = new Map()

  content.split('\n').forEach((rawLine, index) => {
    const line = uncomment(rawLine)
    for (const name of ENV_NAMES) {
      const re = new RegExp(`\\\\begin\\{${name}\\*?\\}`)
      if (re.test(line)) {
        const entry = found.get(name) ?? { count: 0, lines: [] }
        entry.count += 1
        if (entry.lines.length < MAX_ENV_LINES) entry.lines.push(index + 1)
        found.set(name, entry)
      }
    }
  })

  return [...found.entries()]
    .map(([name, entry]) => ({ name, count: entry.count, lines: entry.lines }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function scanPackages(content) {
  const uses = []
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

const envCache = new Map()
const ENV_CACHE_MAX = 500

function environmentsFor(path, content) {
  if (!path.endsWith('.tex')) return []
  const hash = hashContent(content)
  const cached = envCache.get(hash)
  if (cached) return cached
  const scanned = scanEnvironments(content)
  if (envCache.size >= ENV_CACHE_MAX) envCache.clear()
  envCache.set(hash, scanned)
  return scanned
}

const pkgCache = new Map()
const PKG_CACHE_MAX = 500

function packagesFor(path, content) {
  if (!path.endsWith('.tex')) return []
  const hash = hashContent(content)
  let scanned = pkgCache.get(hash)
  if (!scanned) {
    scanned = scanPackages(content)
    if (pkgCache.size >= PKG_CACHE_MAX) pkgCache.clear()
    pkgCache.set(hash, scanned)
  }
  return scanned.map(u => ({ ...u, path }))
}

export function buildProjectIndex({ docs, rootPath }, previous) {
  const entries = Object.entries(docs)
  const hash = hashContent(
    entries
      .map(([path, content]) => `${path} ${hashContent(content)}`)
      .sort()
      .join(' ')
  )

  if (previous && previous.hash === hash && previous.rootPath === rootPath) {
    return previous
  }

  const files = entries
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

  const packages = entries.flatMap(([path, content]) =>
    content.length > MAX_INDEXED_BYTES ? [] : packagesFor(path, content)
  )

  return {
    hash,
    rootPath,
    outline: parseOutline({ docs, rootPath }),
    references: extractReferences({ docs }),
    files,
    packages,
    hasThebibliography: hasThebibliographyEnvironment({ docs }),
  }
}

/** Titles compared with LaTeX commands stripped, whitespace collapsed, case folded. */
export function normaliseSectionTitle(title) {
  return title
    .replace(/\\[a-zA-Z]+\*?(\{[^}]*\})?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function matchSection(outline, query) {
  const wanted = normaliseSectionTitle(query)
  if (!wanted) return { kind: 'none' }

  const normalised = outline.sections.map(section => ({
    section,
    title: normaliseSectionTitle(section.title),
  }))

  const exactHits = normalised.filter(e => e.title === wanted)
  if (exactHits.length === 1) return { kind: 'exact', section: exactHits[0].section }
  if (exactHits.length > 1) return { kind: 'ambiguous', candidates: exactHits.map(e => e.section) }

  const prefixes = normalised.filter(e => e.title.startsWith(wanted))
  if (prefixes.length === 1) return { kind: 'exact', section: prefixes[0].section }
  if (prefixes.length > 1) return { kind: 'ambiguous', candidates: prefixes.map(e => e.section) }
  return { kind: 'none' }
}
```

> **TRAP — before copying, diff the browser sources against the snippets above.** The browser files may have changed after 2026-09-17 (the editor-tooling WS5 plan touches `project-index.ts`). If they differ, port the current browser code instead. The parity test is the arbiter: it must pass against whatever the browser files contain today.

> **TRAP — `uncomment` is declared once** and shared by the outline, references, and environment code. The TypeScript files each declare their own identical copy. Do not declare it twice in one module (that is a `SyntaxError`).

- [x] **Step 4: Run the parity test**

Same command as Step 2. Expected: `Tests  6 passed (6)`. If a comparison fails, the port differs from the browser. Fix the port; never the test or the browser file.

---

### Task 2: Project snapshot and a real `list_files`

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistGlob.mjs`
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (constructor; new `_getFilesList`, `_getSnapshot`, `invalidateSnapshot`; `list_files` case; `edit_file`/`create_file`/`configure_compiler_settings` invalidation; `list_files` spec)
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`

**Interfaces:**
- Produces: `matchesGlob(path: string, pattern: string): boolean` (named export of `AiAssistGlob.mjs`).
- Produces (tools): `async _getSnapshot(projectId): Promise<{ docs: Array<{ _id, path, name, lines: string[] }>, files: Array<{ _id, path }>, rootPath: string | null, docTexts: Record<string, string> }>`, and `invalidateSnapshot(projectId): void`.
- Produces: the `list_files` result is `{ files: Array<{ path, type: 'doc' | 'binary', lines?: number }>, total: number, truncated: boolean }`.

- [x] **Step 1: Write the failing tests**

Add to `AiAssistTools.test.mjs`:

```js
  describe('project snapshot', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    it('flushes once and reads docs in bulk instead of fetching each document', async function () {
      mockDocUpdater.flushProjectToMongo = sinon.stub().resolves()
      mockEntityHandler.getAllDocs = sinon.stub().resolves({
        '/main.tex': { _id: 'doc-1', name: 'main.tex', lines: ['\\section{Intro}'] },
        '/sections/a.tex': { _id: 'doc-2', name: 'a.tex', lines: ['text'] },
      })

      await tools.execute('list_files', {}, ctx)
      await tools.execute('search_text', { query: 'intro' }, ctx)

      expect(mockDocUpdater.flushProjectToMongo.calledOnce).to.equal(true)
      expect(mockEntityHandler.getAllDocs.calledOnce).to.equal(true)
      expect(mockDocUpdater.getDocument.called).to.equal(false)
    })

    it('falls back to per-document reads when flushing is unavailable', async function () {
      const snapshot = await tools._getSnapshot('p1')
      expect(snapshot.docs.find(d => d.path === 'main.tex').lines).to.deep.equal([
        'line 1',
        'line 2: target text',
        'line 3',
      ])
    })

    it('resolves the root document path', async function () {
      const snapshot = await tools._getSnapshot('p1')
      expect(snapshot.rootPath).to.equal('main.tex')
    })

    it('rebuilds after an edit is applied', async function () {
      mockDocUpdater.flushProjectToMongo = sinon.stub().resolves()
      await tools._getSnapshot('p1')
      await tools.execute('edit_file', { path: 'main.tex', oldText: 'target text', newText: 'new text' }, ctx)
      await tools._getSnapshot('p1')
      expect(mockDocUpdater.flushProjectToMongo.calledTwice).to.equal(true)
    })
  })

  describe('list_files', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    it('lists binary files next to docs, sorted, and filters by glob', async function () {
      mockEntityHandler.getAllFiles = sinon.stub().resolves({
        '/figures/plot.png': { _id: 'f1', name: 'plot.png' },
      })

      const all = await tools.execute('list_files', {}, ctx)
      expect(all.files.map(f => `${f.path}:${f.type}`)).to.deep.equal([
        'chapters/intro.tex:doc',
        'figures/plot.png:binary',
        'main.tex:doc',
        'references.bib:doc',
      ])
      expect(all.total).to.equal(4)
      expect(all.truncated).to.equal(false)

      const figures = await tools.execute('list_files', { glob: 'figures/*' }, ctx)
      expect(figures.files.map(f => f.path)).to.deep.equal(['figures/plot.png'])
    })
  })

  describe('matchesGlob', function () {
    it('matches like the browser helper', async function () {
      const { matchesGlob } = await import('../../../app/src/AiAssistGlob.mjs')
      const browser = await import('../../../frontend/js/features/ai-assist/agent/tools/search-text.ts')
      const cases = [
        ['sections/a.tex', 'sections/*.tex'],
        ['sections/deep/a.tex', 'sections/*.tex'],
        ['sections/deep/a.tex', 'sections/**/*.tex'],
        ['a.tex', '**/*.tex'],
        ['main.tex', 'mai?.tex'],
        ['file(1).tex', 'file(1).tex'],
      ]
      for (const [path, pattern] of cases) {
        expect(matchesGlob(path, pattern), `${path} ~ ${pattern}`).to.equal(browser.matchesGlob(path, pattern))
      }
    })
  })
```

> **TRAP — importing `search-text.ts` in Vitest.** It imports `./registry` (for the `AgentTool` type) and `../project-handle`. If that import fails to resolve (for example because `registry.ts` pulls in a file that uses the `@/` webpack alias), delete the browser import from this test and replace the loop with literal expectations: `true, false, true, true, true, true`, in the order of `cases`.

- [x] **Step 2: Run to verify they fail**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs 2>&1 | grep -E "Tests |×" | head -10
```
Expected: the new tests fail.

- [x] **Step 3: Create the glob helper**

Create `modules/ai-assist/app/src/AiAssistGlob.mjs`:
```js
const SPECIALS = /[.+^${}()|[\]\\]/g

/**
 * Minimal glob matching: `*` stops at a slash, `**` crosses them.
 * Port of frontend/js/features/ai-assist/agent/tools/search-text.ts:matchesGlob.
 */
export function matchesGlob(path, pattern) {
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
```

- [x] **Step 4: Add the snapshot to `AiAssistTools`**

At the top of `AiAssistTools.mjs`, add to the imports:
```js
import { matchesGlob } from './AiAssistGlob.mjs'
```
and below the imports:
```js
// A tool call reads the project through one snapshot: one flush plus one bulk
// read, instead of one document-updater request per document per call. Short
// enough that a user typing alongside the agent is seen on the next step;
// read_file and edit_file still read the live document.
const SNAPSHOT_TTL_MS = 5000
const MAX_FILE_ROWS = 400
```

In the constructor, after `this.lastCompileResult = new Map()`, add:
```js
    this._snapshots = new Map()
```

Add these methods right after `_getDocsList`:
```js
  async _getFilesList(projectId) {
    if (!this.entityHandler.getAllFiles) return []
    const raw = await this.entityHandler.getAllFiles(projectId)
    const entries = Array.isArray(raw)
      ? raw.map(file => [file.path || file.name || '', file])
      : Object.entries(raw || {})
    return entries.map(([filePath, file]) => ({
      _id: file._id,
      path: String(filePath).replace(/^\//, ''),
    }))
  }

  invalidateSnapshot(projectId) {
    this._snapshots.delete(String(projectId))
  }

  async _getSnapshot(projectId) {
    const key = String(projectId)
    const now = Date.now()
    const cached = this._snapshots.get(key)
    if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.value

    // Cached snapshots can only grow as projects are opened; drop stale ones.
    for (const [otherKey, entry] of this._snapshots) {
      if (now - entry.at >= SNAPSHOT_TTL_MS) this._snapshots.delete(otherKey)
    }

    let flushed = false
    if (this.docUpdater.flushProjectToMongo) {
      try {
        await this.docUpdater.flushProjectToMongo(projectId)
        flushed = true
      } catch {
        // fall back to reading each document from the document updater
      }
    }

    const listed = await this._getDocsList(projectId)
    const docs = flushed
      ? listed
      : await Promise.all(
          listed.map(async doc => {
            try {
              const fetched = await this.docUpdater.getDocument(projectId, doc._id)
              if (fetched?.lines) return { ...doc, lines: fetched.lines }
            } catch {
              // keep the docstore copy
            }
            return doc
          })
        )

    let rootPath = null
    try {
      const project = await this.projectGetter.getProject(projectId, { rootDoc_id: 1 })
      if (project?.rootDoc_id) {
        const root = docs.find(doc => String(doc._id) === String(project.rootDoc_id))
        rootPath = root ? root.path : null
      }
    } catch {
      // no root document: index in file order
    }

    const files = await this._getFilesList(projectId).catch(() => [])
    const docTexts = {}
    for (const doc of docs) docTexts[doc.path] = (doc.lines || []).join('\n')

    const value = { docs, files, rootPath, docTexts }
    this._snapshots.set(key, { at: Date.now(), value })
    return value
  }
```

> **TRAP — after a flush, docstore is authoritative for every document**, so the per-document `getDocument` loop is skipped completely. Do not add a "fetch if lines are empty" shortcut: an empty document legitimately has `lines: ['']` or `[]`.

- [x] **Step 5: Replace `list_files` and invalidate on writes**

Replace the `list_files`/`project_map` case:
```js
      case 'list_files':
      case 'project_map': {
        const docs = await this._getDocsList(projectId)
        const files = docs.map(doc => ({
          path: doc.path,
          lines: doc.lines?.length || 0,
          type: 'doc',
        }))
        return { files }
      }
```
with:
```js
      case 'list_files':
      case 'project_map': {
        const snapshot = await this._getSnapshot(projectId)
        const all = [
          ...snapshot.docs.map(doc => ({ path: doc.path, type: 'doc', lines: (doc.lines || []).length })),
          ...snapshot.files.map(file => ({ path: file.path, type: 'binary' })),
        ].sort((a, b) => a.path.localeCompare(b.path))
        const listed = typeof args.glob === 'string' && args.glob
          ? all.filter(file => matchesGlob(file.path, args.glob))
          : all
        const shown = listed.slice(0, MAX_FILE_ROWS)
        return { files: shown, total: listed.length, truncated: listed.length > shown.length }
      }
```

Invalidate after every write that changes the file tree or content:
- In `case 'edit_file'` (after WS2 it is `const plan = …; if (plan.result) return plan.result; await this.docUpdater.setDocument(…)`), add `this.invalidateSnapshot(projectId)` right after the `setDocument` line.
- In `case 'create_file'`, add `this.invalidateSnapshot(projectId)` immediately before each of its two success returns: before `return { status: 'applied', path: args.path, docId: doc?._id }`, and inside the `addDoc` callback before `resolve({ status: 'applied', … })`.
- In `case 'configure_compiler_settings'` (it can change the root document), add `this.invalidateSnapshot(projectId)` before its success `return`. Find it with `grep -n "case 'configure_compiler_settings'" -A80 modules/ai-assist/app/src/AiAssistTools.mjs | grep -n "return {"` and add the call before the return whose `status` is `'applied'`.

Replace the `list_files` entry in `getToolSpecs()`:
```js
      {
        name: 'list_files',
        description:
          'List the files in the project with their type and line count. Pass glob to narrow the listing, for example sections/*.tex. Answered from a prebuilt index, so it is far cheaper than reading files.',
        parameters: {
          type: 'object',
          properties: {
            glob: {
              type: 'string',
              description: 'Pattern to narrow the listing, e.g. sections/*.tex',
            },
          },
        },
      },
```

- [x] **Step 6: Update the existing object-dictionary test**

In `'handles getAllDocs returning an object dictionary (Overleaf real production format)'`, the `listRes` expectations still hold (2 docs, no `getAllFiles` mock). Run the suite; if `listRes.files` has a different order than the test assumes, only `.map(f => f.path)).to.include('ref.bib')` is checked, so it still passes. Change nothing unless it fails.

- [x] **Step 7: Run the tools tests**

Same command as Step 2. The `search_text` part of the first snapshot test still fails until Task 4, because `search_text` still calls `getDocument`. Expected at this point: only `'flushes once and reads docs in bulk…'` fails. Every other test passes.

---

### Task 3: Real `get_outline`, `get_packages`, `get_references`

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (the three cases, their specs, a new `_getIndex`)
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs` (replace `'executes get_outline, get_packages, and get_references tools'`)

**Interfaces:**
- Consumes: `buildProjectIndex`, `matchSection` from Task 1; `_getSnapshot` from Task 2.
- Produces: result shapes identical to the browser tools' `execute` (`agent/tools/get-outline.ts`, `get-packages.ts`, `get-references.ts`).

- [x] **Step 1: Replace the placeholder test with real expectations**

Replace the whole test `'executes get_outline, get_packages, and get_references tools'` with:

```js
  describe('index tools', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    beforeEach(function () {
      mockDocUpdater.flushProjectToMongo = sinon.stub().resolves()
      mockEntityHandler.getAllDocs = sinon.stub().resolves({
        '/main.tex': {
          _id: 'doc-1',
          name: 'main.tex',
          lines: [
            '\\documentclass{article}',
            '\\usepackage[margin=1in]{geometry}',
            '\\begin{document}',
            '\\section{Intro}\\label{sec:intro}',
            'See \\ref{sec:intro} and \\ref{sec:nope} and \\cite{knuth84}.',
            '\\subsection{Background}',
            '\\section{Method}',
            '\\end{document}',
          ],
        },
        '/refs.bib': { _id: 'doc-bib', name: 'refs.bib', lines: ['@book{knuth84,', '}'] },
      })
    })

    it('get_outline returns the section tree', async function () {
      const res = await tools.execute('get_outline', {}, ctx)
      expect(res.documentClass).to.equal('article')
      expect(res.sections.map(s => `${s.level}:${s.title}:${s.line}`)).to.deep.equal([
        '1:Intro:4',
        '2:Background:6',
        '1:Method:7',
      ])
    })

    it('get_outline narrows to one section with a line range', async function () {
      const res = await tools.execute('get_outline', { section: 'intro' }, ctx)
      expect(res.range).to.deep.equal({ from: 4, to: 6 })
      expect(res.sections.map(s => s.title)).to.deep.equal(['Intro', 'Background'])
      expect(res.hint).to.equal('read_file with path=main.tex from=4 to=6 for the body')
    })

    it('get_outline reports an unknown section with candidates', async function () {
      const res = await tools.execute('get_outline', { section: 'Results' }, ctx)
      expect(res.error).to.include('No section matches')
      expect(res.candidates).to.deep.equal(['Intro', 'Background', 'Method'])
    })

    it('get_packages lists packages with locations', async function () {
      const res = await tools.execute('get_packages', {}, ctx)
      expect(res.documentClass).to.equal('article')
      expect(res.packages).to.deep.equal([{ name: 'geometry', line: 2, path: 'main.tex' }])
    })

    it('get_references resolves refs and citations', async function () {
      const res = await tools.execute('get_references', { unresolvedOnly: true }, ctx)
      expect(res.refs.map(r => r.key)).to.deep.equal(['sec:nope'])
      expect(res.citations).to.deep.equal([])
      expect(res.labels.map(l => l.key)).to.deep.equal(['sec:intro'])
    })
  })
```

Why `range.to` is 6: the next section at the same or a higher level in the same file is `Method` at line 7, so the range ends at 7 - 1.

- [x] **Step 2: Run to verify they fail**

Same command as Task 2 Step 2. Expected: the five `index tools` tests fail.

- [x] **Step 3: Implement**

Add to the imports of `AiAssistTools.mjs`:
```js
import { buildProjectIndex, matchSection } from './AiAssistProjectIndex.mjs'
```

In the constructor, after `this._snapshots = new Map()`:
```js
    this._indexes = new Map()
```

Add after `_getSnapshot`:
```js
  async _getIndex(projectId) {
    const snapshot = await this._getSnapshot(projectId)
    const key = String(projectId)
    // buildProjectIndex returns `previous` unchanged when no file changed.
    const index = buildProjectIndex(
      { docs: snapshot.docTexts, rootPath: snapshot.rootPath },
      this._indexes.get(key)
    )
    this._indexes.set(key, index)
    return index
  }
```

Replace the three placeholder cases:
```js
      case 'get_outline': {
        const docs = await this._getDocsList(projectId)
        const rootDoc = docs.find(d => d.name === 'main.tex' || d.path === 'main.tex') || docs[0]
        return { rootDoc: rootDoc?.path || rootDoc?.name || 'main.tex', sections: [] }
      }

      case 'get_packages': {
        return { packages: [] }
      }

      case 'get_references': {
        return { references: [] }
      }
```
with (ported from the browser tools' `execute`):
```js
      case 'get_outline': {
        const index = await this._getIndex(projectId)
        const section = typeof args.section === 'string' ? args.section : ''

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
            candidates: match.candidates.map(c => ({ title: c.title, path: c.path, line: c.line })),
          }
        }
        const target = match.section
        const siblings = index.outline.sections
        const startIndex = siblings.indexOf(target)
        const nextPeer = siblings
          .slice(startIndex + 1)
          .find(candidate => candidate.level <= target.level)
        const nextPeerInFile = siblings
          .slice(startIndex + 1)
          .find(candidate => candidate.path === target.path && candidate.level <= target.level)
        const end = nextPeerInFile ? nextPeerInFile.line - 1 : Number.MAX_SAFE_INTEGER
        const nextIndex = nextPeer ? siblings.indexOf(nextPeer) : siblings.length
        return {
          range: { from: target.line, to: end },
          sections: siblings.slice(startIndex, nextIndex),
          hint: `read_file with path=${target.path} from=${target.line} to=${
            end === Number.MAX_SAFE_INTEGER ? 'end' : end
          } for the body`,
        }
      }

      case 'get_packages': {
        const index = await this._getIndex(projectId)
        return {
          documentClass: index.outline.documentClass,
          packages: index.packages,
        }
      }

      case 'get_references': {
        const index = await this._getIndex(projectId)
        const refs = index.references
        const kind = typeof args.kind === 'string' ? args.kind : 'all'
        const pick = {
          labels: { labels: refs.labels, duplicateLabels: refs.duplicateLabels },
          refs: { refs: refs.refs },
          citations: { citations: refs.citations, bibKeys: refs.bibKeys },
          all: refs,
        }[kind] ?? refs

        if (!args.unresolvedOnly) return pick

        const filterUnresolved = uses => uses.filter(use => !use.resolved)
        return {
          ...('refs' in pick ? { refs: filterUnresolved(pick.refs) } : {}),
          ...('citations' in pick ? { citations: filterUnresolved(pick.citations) } : {}),
          ...('labels' in pick ? { labels: pick.labels, duplicateLabels: pick.duplicateLabels } : {}),
          ...('bibKeys' in pick ? { bibKeys: pick.bibKeys } : {}),
        }
      }
```

> **TRAP — `args.unresolvedOnly` may arrive as the string `"true"`** from weaker models. Leave it truthy-checked as the browser does. `"false"` would also be truthy, which matches browser behaviour; do not add special handling here.

Replace the three specs in `getToolSpecs()` with the browser descriptions:
```js
      {
        name: 'get_outline',
        description:
          "The section tree with each section's file and line range, plus the \\input graph. Pass section to get one subtree. Use this before read_file to find where something lives — it costs a fraction of reading the file.",
        parameters: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              description: 'Return only this section and its subsections',
            },
          },
        },
      },
      {
        name: 'get_packages',
        description:
          "The documentclass and every \\usepackage in the project, with the file and line that loads it. Use this to check whether a command's package is available before assuming it is missing.",
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_references',
        description:
          'Every \\label, \\ref and \\cite in the project with its file, line and whether it resolves, plus any duplicated labels. Pass kind to narrow, or unresolvedOnly to see just what is broken.',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['labels', 'refs', 'citations', 'all'],
              description: 'Which kind to return. Defaults to all.',
            },
            unresolvedOnly: {
              type: 'boolean',
              description: 'Return only refs and citations that do not resolve',
            },
          },
        },
      },
```

- [x] **Step 4: Run the tools tests**

Same command. Expected: the `index tools` tests pass. The only remaining failure is the Task 2 bulk-read test, which Task 4 fixes.

---

### Task 4: `search_text` and `read_file` parity (regex in a worker)

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistRegexSearch.mjs`
- Create: `modules/ai-assist/test/unit/src/AiAssistRegexSearch.test.mjs`
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (`read_file` and `search_text` cases and specs)
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs` (update 2 existing tests, add new ones)

**Interfaces:**
- Produces: `regexSearch({ query, caseSensitive, docs, limit, timeoutMs? }): Promise<{ hits: Array<{ path, line }>, total: number }>`. It rejects with an `Error` whose `code` is `'regexTimeout'` on timeout, and with a `SyntaxError` for an invalid pattern.
- Produces: `search_text` result `{ hits: Array<{ path, line, text, before?, after? }>, total, truncated }`.
- Produces: `read_file` result `{ path, from, to, totalLines, content, truncated, nextRange? }`, where `content` is numbered as `"<n>: <line>"`.

- [x] **Step 1: Write the failing worker tests**

Create `modules/ai-assist/test/unit/src/AiAssistRegexSearch.test.mjs`:

```js
import { expect } from 'chai'
import { regexSearch } from '../../../app/src/AiAssistRegexSearch.mjs'

const docs = [
  { path: 'main.tex', lines: ['\\section{Intro}', 'plain text', '\\SECTION{Loud}'] },
  { path: 'b.tex', lines: ['\\subsection{Deep}'] },
]

describe('regexSearch', function () {
  it('finds line matches case-insensitively by default', async function () {
    const res = await regexSearch({ query: '\\\\section\\{', caseSensitive: false, docs, limit: 50 })
    expect(res.hits).to.deep.equal([
      { path: 'main.tex', line: 1 },
      { path: 'main.tex', line: 3 },
    ])
    expect(res.total).to.equal(2)
  })

  it('honours caseSensitive and the hit limit', async function () {
    const res = await regexSearch({ query: 'section', caseSensitive: true, docs, limit: 1 })
    expect(res.hits).to.deep.equal([{ path: 'main.tex', line: 1 }])
    expect(res.total).to.equal(2)
  })

  it('rejects an invalid pattern', async function () {
    let caught = null
    try {
      await regexSearch({ query: '(', caseSensitive: false, docs, limit: 50 })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(SyntaxError)
  })

  it('times out a catastrophic pattern instead of blocking the server', async function () {
    const evil = [{ path: 'x.tex', lines: ['a'.repeat(40) + 'b'] }]
    const started = Date.now()
    let caught = null
    try {
      await regexSearch({ query: '(a+)+$', caseSensitive: false, docs: evil, limit: 50, timeoutMs: 300 })
    } catch (err) {
      caught = err
    }
    expect(caught?.code).to.equal('regexTimeout')
    expect(Date.now() - started).to.be.lessThan(3000)
  })
})
```

- [x] **Step 2: Run to verify it fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRegexSearch.test.mjs 2>&1 | grep -E "Tests |FAIL|Error" | head -5
```
Expected: FAIL (module not found).

- [x] **Step 3: Implement the worker search**

Create `modules/ai-assist/app/src/AiAssistRegexSearch.mjs`:
```js
import { Worker } from 'node:worker_threads'

// Runs in a separate thread. `eval: true` workers are CommonJS scripts, so
// require() is available. Verified on Node 24 on 2026-09-17.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { query, flags, docs, limit } = workerData
const re = new RegExp(query, flags)
const hits = []
let total = 0
for (const doc of docs) {
  for (let i = 0; i < doc.lines.length; i++) {
    if (re.test(doc.lines[i])) {
      total++
      if (hits.length < limit) hits.push({ path: doc.path, line: i + 1 })
    }
  }
}
parentPort.postMessage({ hits, total })
`

/**
 * Line-by-line regex search over project documents, off the main thread.
 *
 * The pattern comes from a model. JavaScript regexes cannot be interrupted, so
 * a catastrophic pattern such as (a+)+$ would freeze the web process for every
 * user. A worker can be terminated when it overruns.
 */
export function regexSearch({ query, caseSensitive, docs, limit, timeoutMs = 2000 }) {
  const flags = caseSensitive ? '' : 'i'
  // Compile once here so an invalid pattern fails fast, without a thread.
  // eslint-disable-next-line no-new
  new RegExp(query, flags)

  return new Promise((resolve, reject) => {
    let settled = false
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        query,
        flags,
        docs: docs.map(doc => ({ path: doc.path, lines: doc.lines || [] })),
        limit,
      },
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void worker.terminate()
      const err = new Error(
        'The regular expression took too long to run. Simplify it or search for a plain string.'
      )
      err.code = 'regexTimeout'
      reject(err)
    }, timeoutMs)
    timer.unref?.()

    worker.once('message', message => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(message)
    })
    worker.once('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}
```

> **TRAP — `new RegExp` throws synchronously** inside `regexSearch`, before the Promise exists. Because `regexSearch` is not `async`, that throw escapes as a synchronous exception. The test uses `await` inside `try`, which catches both kinds. Callers must wrap the call in `try` (Step 7 does).

- [x] **Step 4: Run the worker tests**

Same command as Step 2. Expected: `Tests  4 passed (4)`.

- [x] **Step 5: Write the failing tool tests and update the two existing ones**

In `AiAssistTools.test.mjs`:

1. In `'reads lines from a document via read_file'`, change
   `expect(res.content).to.equal('line 1\nline 2: target text')` to
   `expect(res.content).to.equal('1: line 1\n2: line 2: target text')`.
2. In `'handles getAllDocs returning an object dictionary (Overleaf real production format)'`, change
   `expect(readRes.content).to.equal('@article{sample}')` to
   `expect(readRes.content).to.equal('1: @article{sample}')`.
3. Add:

```js
  describe('search_text', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    beforeEach(function () {
      mockDocUpdater.flushProjectToMongo = sinon.stub().resolves()
      mockEntityHandler.getAllDocs = sinon.stub().resolves({
        '/main.tex': { _id: 'doc-1', name: 'main.tex', lines: ['\\section{Intro}', 'Hello World', 'bye'] },
        '/sections/a.tex': { _id: 'doc-2', name: 'a.tex', lines: ['hello again'] },
      })
    })

    it('is case-insensitive by default and returns context lines', async function () {
      const res = await tools.execute('search_text', { query: 'hello' }, ctx)
      expect(res.total).to.equal(2)
      expect(res.hits[0]).to.deep.equal({
        path: 'main.tex',
        line: 2,
        text: 'Hello World',
        before: ['\\section{Intro}'],
        after: ['bye'],
      })
    })

    it('honours caseSensitive, glob and contextLines 0', async function () {
      const res = await tools.execute(
        'search_text',
        { query: 'hello', caseSensitive: true, glob: 'sections/*.tex', contextLines: 0 },
        ctx
      )
      expect(res.hits).to.deep.equal([{ path: 'sections/a.tex', line: 1, text: 'hello again' }])
    })

    it('supports regular expressions', async function () {
      const res = await tools.execute('search_text', { query: '^\\\\section\\{', regexp: true }, ctx)
      expect(res.hits.map(h => `${h.path}:${h.line}`)).to.deep.equal(['main.tex:1'])
    })

    it('returns an error for an invalid regular expression', async function () {
      const res = await tools.execute('search_text', { query: '(', regexp: true }, ctx)
      expect(res.error).to.include('regular expression')
    })
  })

  describe('read_file limits', function () {
    const ctx = { projectId: 'p1', userId: '012345678901234567890123' }

    it('caps a long read at 1000 lines and says where to continue', async function () {
      const lines = Array.from({ length: 1500 }, (_, i) => `l${i + 1}`)
      mockDocUpdater.getDocument = sinon.stub().resolves({ lines })

      const res = await tools.execute('read_file', { path: 'main.tex' }, ctx)

      expect(res.from).to.equal(1)
      expect(res.to).to.equal(1000)
      expect(res.totalLines).to.equal(1500)
      expect(res.truncated).to.equal(true)
      expect(res.nextRange).to.deep.equal({ from: 1001, to: 1500 })
      expect(res.content.split('\n')[999]).to.equal('1000: l1000')
    })

    it('explains that a binary file cannot be read as text', async function () {
      mockEntityHandler.getAllFiles = sinon.stub().resolves({ '/fig.png': { _id: 'f1', name: 'fig.png' } })
      const res = await tools.execute('read_file', { path: 'fig.png' }, ctx)
      expect(res.error).to.equal('fig.png is a binary file and cannot be read as text.')
    })
  })
```

- [x] **Step 6: Run to verify the new and updated tests fail**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs 2>&1 | grep -E "Tests |×" | head -12
```
Expected: failures in the updated read tests, `search_text`, `read_file limits`, and the Task 2 bulk-read test.

- [x] **Step 7: Implement `search_text` and `read_file`**

Add to the imports of `AiAssistTools.mjs`:
```js
import { regexSearch } from './AiAssistRegexSearch.mjs'
```
and add next to `MAX_FILE_ROWS`:
```js
const MAX_READ_LINES = 1000
const MAX_SEARCH_HITS = 50
```

Replace the `read_file` case:
```js
      case 'read_file': {
        const doc = await this._resolveDoc(projectId, args.path)
        if (!doc) return { error: `File not found: ${args.path}` }
        let lines = doc.lines
        try {
          const fetched = await this.docUpdater.getDocument(projectId, doc._id)
          if (fetched?.lines) lines = fetched.lines
        } catch {
          // keep fallback lines
        }
        const totalLines = lines.length
        const from = Math.max(1, Math.min(args.from || 1, totalLines || 1))
        const to = Math.min(args.to || totalLines, totalLines)
        const sliced = lines.slice(from - 1, to)
        return {
          path: args.path,
          from,
          to,
          totalLines,
          content: sliced.join('\n'),
        }
      }
```
with:
```js
      case 'read_file': {
        const doc = await this._resolveDoc(projectId, args.path)
        if (!doc) {
          const wanted = String(args.path || '').replace(/^\//, '')
          const files = await this._getFilesList(projectId).catch(() => [])
          if (files.some(file => file.path === wanted)) {
            return { error: `${wanted} is a binary file and cannot be read as text.` }
          }
          return { error: `File not found: ${args.path}` }
        }
        let lines = doc.lines || []
        try {
          // The live document, not the snapshot: the user may be typing.
          const fetched = await this.docUpdater.getDocument(projectId, doc._id)
          if (fetched?.lines) lines = fetched.lines
        } catch {
          // keep fallback lines
        }
        const totalLines = lines.length
        const start = Math.max(1, Math.min(Number(args.from) || 1, totalLines || 1))
        const requestedEnd = Math.min(Number(args.to) || totalLines, totalLines)
        const capped = lines.slice(start - 1, requestedEnd).slice(0, MAX_READ_LINES)
        const end = start + capped.length - 1
        const nextRange = end < totalLines
          ? { from: end + 1, to: Math.min(end + MAX_READ_LINES, totalLines) }
          : undefined
        return {
          path: args.path,
          from: start,
          to: end,
          totalLines,
          content: capped.map((line, i) => `${start + i}: ${line}`).join('\n'),
          truncated: Boolean(nextRange),
          ...(nextRange ? { nextRange } : {}),
        }
      }
```

> **TRAP — `nextRange` for a deliberately short range.** A call like `from=1 to=40` on a 1500-line file returns `truncated: true` with `nextRange {41..1040}`. That matches the browser (`agent/tools/read-file.ts`), which also reports "there is more below". Keep it.

Replace the `search_text`/`search_project` case:
```js
      case 'search_text':
      case 'search_project': {
        const docs = await this._getDocsList(projectId)
        const hits = []
        for (const doc of docs) {
          …
        }
        return { hits: hits.slice(0, 50) }
      }
```
with:
```js
      case 'search_text':
      case 'search_project': {
        if (typeof args.query !== 'string' || args.query === '') {
          return { error: "Parameter 'query' is required for search_text." }
        }
        const snapshot = await this._getSnapshot(projectId)
        const pattern = typeof args.glob === 'string' && args.glob
          ? args.glob
          : (typeof args.path === 'string' && args.path ? args.path : null)
        const docs = pattern
          ? snapshot.docs.filter(doc => matchesGlob(doc.path, pattern))
          : snapshot.docs
        const contextLines = Number.isFinite(Number(args.contextLines))
          ? Math.max(0, Math.floor(Number(args.contextLines)))
          : 1

        let found
        if (args.regexp) {
          try {
            found = await regexSearch({
              query: args.query,
              caseSensitive: Boolean(args.caseSensitive),
              docs,
              limit: MAX_SEARCH_HITS,
            })
          } catch (err) {
            if (err.code === 'regexTimeout') return { error: err.message }
            // A SyntaxError message already reads "Invalid regular expression: /(/i: …".
            return {
              error: err instanceof SyntaxError
                ? err.message
                : `Invalid regular expression: ${err.message}`,
            }
          }
        } else {
          const needle = args.caseSensitive ? args.query : args.query.toLowerCase()
          const hits = []
          let total = 0
          for (const doc of docs) {
            const lines = doc.lines || []
            for (let i = 0; i < lines.length; i++) {
              const haystack = args.caseSensitive ? lines[i] : lines[i].toLowerCase()
              if (haystack.includes(needle)) {
                total++
                if (hits.length < MAX_SEARCH_HITS) hits.push({ path: doc.path, line: i + 1 })
              }
            }
          }
          found = { hits, total }
        }

        const byPath = new Map(docs.map(doc => [doc.path, doc.lines || []]))
        return {
          hits: found.hits.map(({ path, line }) => {
            const lines = byPath.get(path) || []
            return {
              path,
              line,
              text: lines[line - 1] ?? '',
              ...(contextLines > 0
                ? {
                    before: lines.slice(Math.max(0, line - 1 - contextLines), line - 1),
                    after: lines.slice(line, line + contextLines),
                  }
                : {}),
            }
          }),
          total: found.total,
          truncated: found.total > found.hits.length,
        }
      }
```

> **TRAP — the old result trimmed `text`** (`line.trim()`). The browser returns the untrimmed line, and the new code follows the browser. The existing test `'searches across project documents via search_text and search_project alias'` only checks `path` and `line`, so it still passes.

> **TRAP — regex matches whole lines**, not across line breaks as the browser's CodeMirror cursor does. Multi-line patterns are rare in agent searches; this is an accepted difference. Do not load whole documents into one string for the worker.

Replace the `read_file` and `search_text` entries in `getToolSpecs()`:
```js
      {
        name: 'read_file',
        description:
          'Read one text file, or a line range of one, as numbered lines. Get the range from get_outline or search_text first rather than guessing it.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file to read' },
            from: { type: 'number', description: 'First line, 1-indexed' },
            to: { type: 'number', description: 'Last line, inclusive' },
          },
          required: ['path'],
        },
      },
      {
        name: 'search_text',
        description:
          "Find a string or regular expression across the project's text files, with surrounding context lines. Pass glob to search only matching files. Use this to locate something whose file you do not know.",
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
```

- [x] **Step 8: Run the tools tests**

Same command as Step 6. Expected: 0 failed, including the Task 2 bulk-read test. The existing `'searches across project documents via search_text and search_project alias'` still passes through the per-document fallback, because its mocks have no `flushProjectToMongo`.

---

### Task 5: Render tool results compactly for the model

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistToolRender.mjs`
- Create: `modules/ai-assist/test/unit/src/AiAssistToolRender.test.mjs`
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs` (`toAgentMessages`, lines 43-54; the tool-message push from WS2 Task 1)
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

**Interfaces:**
- Produces: `renderToolResult(name: string, result: unknown): string`. Tools without a renderer, and results that are not objects, fall back to `JSON.stringify(result)`.
- The events and the stored transcript keep the **structured** result. Only the provider-facing `content` string changes.

- [x] **Step 1: Write the failing render tests**

Create `modules/ai-assist/test/unit/src/AiAssistToolRender.test.mjs`:
```js
import { expect } from 'chai'
import { renderToolResult } from '../../../app/src/AiAssistToolRender.mjs'

describe('renderToolResult', function () {
  it('renders read_file as a fenced block with a header and continuation hint', function () {
    const text = renderToolResult('read_file', {
      path: 'main.tex',
      from: 1,
      to: 2,
      totalLines: 5,
      content: '1: a\n2: b',
      truncated: true,
      nextRange: { from: 3, to: 5 },
    })
    expect(text).to.equal(
      'main.tex lines 1-2 of 5\n```\n1: a\n2: b\n```\n(truncated - call read_file with from=3, to=5 for the rest)'
    )
  })

  it('renders list_files rows and marks binaries', function () {
    const text = renderToolResult('list_files', {
      files: [
        { path: 'main.tex', type: 'doc', lines: 12 },
        { path: 'fig.png', type: 'binary' },
      ],
      total: 3,
      truncated: true,
    })
    expect(text).to.equal('main.tex  doc  12\nfig.png  binary\n(1 more; narrow with glob=)')
  })

  it('renders get_outline as an indented tree', function () {
    const text = renderToolResult('get_outline', {
      documentClass: 'article',
      sections: [
        { path: 'main.tex', line: 4, level: 1, title: 'Intro' },
        { path: 'main.tex', line: 6, level: 2, title: 'Background' },
      ],
      includes: [{ from: 'main.tex', to: 'b.tex', line: 9, resolved: false }],
      notes: [],
    })
    expect(text).to.equal(
      'documentclass: article\n    main.tex:4 Intro\n      main.tex:6 Background\n\\input main.tex:9 -> b.tex (UNRESOLVED)'
    )
  })

  it('renders get_packages and get_references', function () {
    expect(renderToolResult('get_packages', {
      documentClass: 'article',
      packages: [{ name: 'geometry', path: 'main.tex', line: 2 }],
    })).to.equal('documentclass: article\ngeometry  (main.tex:2)')

    expect(renderToolResult('get_references', {
      refs: [{ command: 'ref', key: 'sec:x', path: 'main.tex', line: 5, resolved: false }],
    })).to.equal('ref sec:x  main.tex:5  UNRESOLVED')

    expect(renderToolResult('get_references', {})).to.equal(
      '(no labels, references, or citations found in project)'
    )
  })

  it('keeps errors and unknown tools as JSON', function () {
    expect(renderToolResult('read_file', { error: 'File not found: x' })).to.equal('{"error":"File not found: x"}')
    expect(renderToolResult('compile_project', { status: 'success' })).to.equal('{"status":"success"}')
    expect(renderToolResult('read_file', null)).to.equal('null')
  })
})
```

- [x] **Step 2: Run to verify it fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistToolRender.test.mjs 2>&1 | grep -E "Tests |FAIL|Error" | head -5
```
Expected: FAIL (module not found).

- [x] **Step 3: Implement**

Create `modules/ai-assist/app/src/AiAssistToolRender.mjs`. The renderers are ports of the `render()` methods in `frontend/js/features/ai-assist/agent/tools/{get-outline,get-packages,get-references,list-files,read-file}.ts`, except that `list_files` shows `binary` because server file refs have no size:

```js
/**
 * Plain-text renderings of tool results for the model.
 *
 * File content inside JSON is mostly escape sequences. Rendering it as text
 * costs roughly a third fewer tokens and the model quotes it back more
 * accurately. Events and the stored transcript keep the structured result;
 * only the provider-facing message content uses this.
 */

function outlineLine(section) {
  return `${'  '.repeat(section.level + 1)}${section.path}:${section.line} ${section.title}`
}

const RENDERERS = {
  get_outline(result) {
    if (result.sections && result.range) {
      return [
        `section lines ${result.range.from}-${result.range.to}`,
        ...result.sections.map(outlineLine),
        result.hint ?? '',
      ]
        .filter(Boolean)
        .join('\n')
    }
    if (result.sections) {
      return [
        `documentclass: ${result.documentClass ?? 'unknown'}`,
        ...result.sections.map(outlineLine),
        ...(result.includes || []).map(
          i => `\\input ${i.from}:${i.line} -> ${i.to}${i.resolved ? '' : ' (UNRESOLVED)'}`
        ),
        ...(result.notes || []),
      ].join('\n')
    }
    return JSON.stringify(result)
  },

  get_packages(result) {
    if (!result.packages) return JSON.stringify(result)
    return [
      `documentclass: ${result.documentClass ?? 'unknown'}`,
      ...result.packages.map(pkg => `${pkg.name}  (${pkg.path}:${pkg.line})`),
    ].join('\n')
  },

  get_references(result) {
    const lines = []
    if (result.labels) {
      lines.push(...result.labels.map(l => `label ${l.key}  ${l.path}:${l.line}`))
      lines.push(...(result.duplicateLabels ?? []).map(k => `DUPLICATE label ${k}`))
    }
    if (result.refs) {
      lines.push(...result.refs.map(r => `${r.command} ${r.key}  ${r.path}:${r.line}  ${r.resolved ? 'ok' : 'UNRESOLVED'}`))
    }
    if (result.citations) {
      lines.push(...result.citations.map(c => `${c.command} ${c.key}  ${c.path}:${c.line}  ${c.resolved ? 'ok' : 'MISSING'}`))
    }
    if (result.bibKeys) {
      lines.push(...result.bibKeys.map(b => `bib ${b.key}  ${b.path}:${b.line}`))
    }
    return lines.length > 0
      ? lines.join('\n')
      : '(no labels, references, or citations found in project)'
  },

  list_files(result) {
    if (!result.files) return JSON.stringify(result)
    const rows = result.files.map(file =>
      file.type === 'binary'
        ? `${file.path}  binary`
        : `${file.path}  ${file.type}  ${file.lines ?? ''}`.trimEnd()
    )
    if (result.truncated) {
      rows.push(`(${result.total - result.files.length} more; narrow with glob=)`)
    }
    return rows.length > 0 ? rows.join('\n') : '(no files found)'
  },

  read_file(result) {
    const header = `${result.path} lines ${result.from}-${result.to} of ${result.totalLines}`
    const footer = result.nextRange
      ? `\n(truncated - call read_file with from=${result.nextRange.from}, to=${result.nextRange.to} for the rest)`
      : ''
    return [header, '```', result.content, '```'].join('\n') + footer
  },
}

export function renderToolResult(name, result) {
  const renderer = RENDERERS[name]
  if (!renderer || result === null || typeof result !== 'object' || result.error) {
    return JSON.stringify(result)
  }
  try {
    return renderer(result)
  } catch {
    return JSON.stringify(result)
  }
}
```

> **TRAP — `get_references` with `{}`.** The test expects the "no labels" sentence for an empty object, and the `result.error` guard does not trip on it. Keep the guard order as written.

- [x] **Step 4: Run the render tests**

Same command as Step 2. Expected: `Tests  5 passed (5)`.

- [x] **Step 5: Write the failing manager test**

Add to `AiAssistRunManager.test.mjs`:
```js
  it('renders tool results as text for the provider and renders history the same way', async function () {
    const readResult = { path: 'main.tex', from: 1, to: 1, totalLines: 1, content: '1: hi', truncated: false }
    let secondRequest = null
    let callCount = 0
    mockClient.streamChat.callsFake(async function* (opts) {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'r1', name: 'read_file', args: { path: 'main.tex' } }
      } else {
        secondRequest = opts
        yield { type: 'text', text: 'done' }
      }
    })
    mockTools.execute.resolves(readResult)

    await manager.startRun({
      runId: 'run-render',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'read' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    const live = secondRequest.messages.find(m => m.role === 'tool')
    expect(live.content).to.equal('main.tex lines 1-1 of 1\n```\n1: hi\n```')

    // The next user turn rebuilds this from the stored transcript; it must be
    // byte-identical or the provider's prompt cache misses.
    const { toAgentMessages } = await import('../../../app/src/AiAssistRunManager.mjs')
    const rebuilt = toAgentMessages([
      { role: 'user', text: 'read' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'r1', name: 'read_file', args: { path: 'main.tex' }, result: readResult }] },
    ]).find(m => m.role === 'tool')
    expect(rebuilt.content).to.equal(live.content)
    expect(rebuilt).to.include({ name: 'read_file', isError: false })
  })
```

- [x] **Step 6: Run to verify it fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs 2>&1 | grep -E "Tests |×" | head -5
```
Expected: 1 failed.

- [x] **Step 7: Implement in the manager**

Add to the imports of `AiAssistRunManager.mjs`:
```js
import { renderToolResult } from './AiAssistToolRender.mjs'
```

In `toAgentMessages`, replace (currently lines 43-54):
```js
    for (const call of entry.toolCalls) {
      const finished = 'result' in call
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: finished
          ? (typeof call.result === 'string' ? call.result : JSON.stringify(call.result))
          : 'This tool call did not complete.',
        isError: finished ? Boolean(call.isError) : true,
      })
    }
```
with:
```js
    for (const call of entry.toolCalls) {
      const finished = 'result' in call
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: finished
          ? (typeof call.result === 'string' ? call.result : renderToolResult(call.name, call.result))
          : 'This tool call did not complete.',
        isError: finished ? Boolean(call.isError || call.result?.error) : true,
      })
    }
```

In the live tool-message push (from WS2 Task 1), change
`content: JSON.stringify(result),` to `content: renderToolResult(call.name, result),`.

> **TRAP — elided stubs stay JSON.** `stubToolMessage` writes `JSON.stringify({ elided: true, … })`, and `isElided` parses the content as JSON. Rendered text fails to parse, so `isElided` returns `false` for it, which is correct. Do not render stubs.

> **TRAP — `isError` in the rebuilt history.** Live messages set `isError: Boolean(isFailed)`, which also counts `status: 'noMatch'`/`'ambiguous'`/`'none'`. `toAgentMessages` cannot see `isFailed`, so it uses `call.isError || call.result?.error`. A rejected or noMatch edit can therefore differ in `isError` between the live request and the rebuilt one. `isError` is not part of Anthropic's cached prefix text in a way that changes content bytes, and it is an accepted difference here. Do not try to make them identical by weakening the live flag.

- [x] **Step 8: Run the manager tests**

Same command as Step 6. Expected: 0 failed.

---

### Task 6: Server uses the full system prompt

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistSystemPrompt.mjs`
- Create: `modules/ai-assist/test/unit/src/AiAssistSystemPrompt.test.mjs`
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs:7-10` (remove `DEFAULT_SYSTEM_PROMPT`) and its two uses in `startRun`

**Interfaces:**
- Produces: `SYSTEM_PROMPT` (named export, string), byte-identical to `frontend/js/features/ai-assist/agent/context/system-prompt.ts`.

- [x] **Step 1: Write the failing parity test**

Create `modules/ai-assist/test/unit/src/AiAssistSystemPrompt.test.mjs`:
```js
import { expect } from 'chai'
import { SYSTEM_PROMPT } from '../../../app/src/AiAssistSystemPrompt.mjs'
import { SYSTEM_PROMPT as BROWSER_PROMPT } from '../../../frontend/js/features/ai-assist/agent/context/system-prompt.ts'
import { AiAssistTools } from '../../../app/src/AiAssistTools.mjs'

describe('AiAssistSystemPrompt', function () {
  it('is identical to the browser agent prompt', function () {
    expect(SYSTEM_PROMPT).to.equal(BROWSER_PROMPT)
  })

  it('only names tools the server actually offers', function () {
    const offered = new Set(new AiAssistTools().getToolSpecs().map(spec => spec.name))
    const named = [...SYSTEM_PROMPT.matchAll(/`([a-z]+_[a-z_]+)`/g)].map(m => m[1])
    for (const name of named) {
      expect(offered.has(name), `prompt names ${name}`).to.equal(true)
    }
  })
})
```

- [x] **Step 2: Run to verify it fails**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistSystemPrompt.test.mjs 2>&1 | grep -E "Tests |FAIL|Error" | head -5
```
Expected: FAIL (module not found).

- [x] **Step 3: Create the prompt module by copying the browser file**

`system-prompt.ts` contains no TypeScript syntax (it is one `export const SYSTEM_PROMPT = [ … ].join('\n')`), so a byte copy is valid JavaScript:
```bash
cp modules/ai-assist/frontend/js/features/ai-assist/agent/context/system-prompt.ts modules/ai-assist/app/src/AiAssistSystemPrompt.mjs
```
Then add one line to the top of the file's leading comment block, directly under `/**`:
```js
 * Server copy of frontend/js/features/ai-assist/agent/context/system-prompt.ts, kept identical by AiAssistSystemPrompt.test.mjs.
```

> **TRAP — check that the copy really has no types:** `grep -nE ": (string|number)|as const|interface " modules/ai-assist/app/src/AiAssistSystemPrompt.mjs` must print nothing. If it prints something, the browser file changed. Remove only the type syntax, and let the parity test prove the string is still identical.

- [x] **Step 4: Use it in the manager**

In `AiAssistRunManager.mjs`, delete the `DEFAULT_SYSTEM_PROMPT` constant (lines 7-10), add the import:
```js
import { SYSTEM_PROMPT } from './AiAssistSystemPrompt.mjs'
```
and replace both uses of `DEFAULT_SYSTEM_PROMPT` in `startRun` (in `applyContextBudget({ system: … })` and in `client.streamChat({ system: … })`) with `SYSTEM_PROMPT`.

```bash
grep -n "DEFAULT_SYSTEM_PROMPT" modules/ai-assist/app/src/*.mjs modules/ai-assist/test/unit/src/*.mjs
```
Expected: no output. If a test imports `DEFAULT_SYSTEM_PROMPT`, change that import to `SYSTEM_PROMPT` from `AiAssistSystemPrompt.mjs`.

- [x] **Step 5: Run the prompt and manager tests**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistSystemPrompt.test.mjs modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs 2>&1 | grep -E "Tests |×" | head -6
```
Expected: 0 failed.

> **TRAP — if "only names tools the server actually offers" fails,** the prompt names a tool the server lacks. Do not edit the prompt to make the test pass. Report the missing tool to the user; it is a server tool gap, not a prompt problem.

---

### Task 7: Run leading read-only tool calls concurrently

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistRunManager.mjs` (before `for (const call of calls)`, and the non-edit execute branch)
- Test: `modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

**Interfaces:**
- Produces: `READ_ONLY_TOOLS` (exported `Set`). Events keep their order: `toolCallStarted`/`toolCallFinished` are still emitted per call, in call order.

- [x] **Step 1: Write the failing test**

```js
  it('executes the leading read-only calls of a turn concurrently, keeping event order', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'a', name: 'read_file', args: { path: 'a.tex' } }
        yield { type: 'tool_call', id: 'b', name: 'search_text', args: { query: 'x' } }
        yield { type: 'tool_call', id: 'c', name: 'get_outline', args: {} }
      } else {
        yield { type: 'text', text: 'done' }
      }
    })

    let inFlight = 0
    let maxInFlight = 0
    mockTools.execute.callsFake(async name => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 20))
      inFlight--
      return { tool: name }
    })

    await manager.startRun({
      runId: 'run-parallel',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'look around' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })

    expect(maxInFlight).to.equal(3)
    const finished = mockStore.appendEvent
      .getCalls()
      .map(c => c.args[1])
      .filter(e => e.type === 'toolCallFinished')
      .map(e => e.id)
    expect(finished).to.deep.equal(['a', 'b', 'c'])
  })

  it('does not run a read ahead of an edit that precedes it in the same turn', async function () {
    let callCount = 0
    mockClient.streamChat.callsFake(async function* () {
      callCount++
      if (callCount === 1) {
        yield { type: 'tool_call', id: 'e', name: 'edit_file', args: { path: 'a.tex', oldText: 'x', newText: 'y' } }
        yield { type: 'tool_call', id: 'r', name: 'read_file', args: { path: 'a.tex' } }
      } else {
        yield { type: 'text', text: 'done' }
      }
    })

    const runPromise = manager.startRun({
      runId: 'run-order',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', content: 'edit then read' }],
      providerSettings: { type: 'openai', apiKey: 'k', model: 'gpt-4o' },
    })
    await new Promise(r => setTimeout(r, 10))

    // Waiting for approval: the read must not have run yet.
    expect(mockTools.execute.calledWith('read_file')).to.equal(false)

    await manager.approveEdit('run-order', { accepted: true })
    await runPromise
    expect(mockTools.execute.calledWith('read_file')).to.equal(true)
  })
```

- [x] **Step 2: Run to verify the first test fails**

Same command as Task 5 Step 6. Expected: `maxInFlight` is 1, so the first test fails; the second passes already.

- [x] **Step 3: Implement**

Add near `FILE_EDIT_TOOLS` (added in WS2 Task 4) in `AiAssistRunManager.mjs`:
```js
// Tools with no side effects. Only these may run ahead of their turn in the
// loop below. compile_project is excluded: it writes the last compile result
// that get_compile_result reads.
export const READ_ONLY_TOOLS = new Set([
  'get_outline',
  'get_packages',
  'get_references',
  'list_files',
  'read_file',
  'search_text',
  'get_compile_result',
  'get_project_settings',
  'list_available_settings',
])
```

Immediately before `for (const call of calls) {`, insert:
```js
        // The reads a model asks for together are independent, so run the ones
        // at the start of the turn at the same time. Stop at the first call
        // that is not read-only: a read listed after an edit expects to see it.
        const prefetched = new Map()
        const leadingReads = []
        for (const call of calls) {
          if (!READ_ONLY_TOOLS.has(call.name)) break
          leadingReads.push(call)
        }
        if (leadingReads.length > 1) {
          await Promise.all(
            leadingReads.map(async call => {
              try {
                const value = await this.tools.execute(call.name, call.args, { projectId, userId })
                prefetched.set(call, { result: value, isError: false })
              } catch (err) {
                prefetched.set(call, {
                  result: { error: err.message || 'Tool execution failed' },
                  isError: true,
                })
              }
            })
          )
        }
```

In the non-edit branch inside the loop, replace:
```js
          } else {
            try {
              result = await this.tools.execute(call.name, call.args, { projectId, userId })
            } catch (err) {
              result = { error: err.message || 'Tool execution failed' }
              isError = true
            }
          }
```
with:
```js
          } else if (prefetched.has(call)) {
            const done = prefetched.get(call)
            result = done.result
            isError = done.isError
          } else {
            try {
              result = await this.tools.execute(call.name, call.args, { projectId, userId })
            } catch (err) {
              result = { error: err.message || 'Tool execution failed' }
              isError = true
            }
          }
```

> **TRAP — `prefetched` is keyed by the call object**, not by `call.id`. Ids are filled in inside the loop (`call.id || \`call_${steps}_${runId}\``), after prefetching.

- [x] **Step 4: Run the manager tests**

Same command. Expected: 0 failed.

---

### Task 8: Final verification and redeploy

- [x] **Step 1: Full backend module suite**

```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src 2>&1 | grep -E "Test Files|Tests "
```
Expected: 0 failed.

- [x] **Step 2: Full frontend module suite (no frontend files changed, but the UI renders server results)**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' --reporter dot modules/ai-assist/test/frontend 2>&1 | grep -E "passing|failing"
```
Expected: same as baseline, 0 failing.

- [x] **Step 3: Redeploy and smoke-test the tools for real**

Restart the dev web container (Docker needs the sandbox disabled):
```bash
docker restart ai-assist-web-1
```
Wait for `curl -s -o /dev/null -w '%{http_code}' http://localhost:81/login` to return `200`. Log in at `http://<host>:81` as `dangdoan2206@gmail.com` / `dang22062003`, open a project that has sections, a `.bib` file, and an image, and ask the AI chat:
1. "What sections does this paper have?" The tool card for `get_outline` must list the real sections.
2. "Which packages are loaded?" `get_packages` must list them.
3. "Find every \\cite that has no bib entry." `get_references` must be called with `unresolvedOnly`.
4. "Search for figure environments using a regex." `search_text` must be called with `regexp: true` and return hits.

Check for errors without dumping the log:
```bash
docker logs --since 5m ai-assist-web-1 2>&1 | grep -iE "AiAssist|worker|regex" | grep -iE "error|fail" | head -5
```
Report the URL, the web debug port `9241`, and what each question produced.

## Out of scope

- **Moving the compile-error fix panel to the server.** It runs in the browser on purpose: it edits through CodeMirror, and the editor-tooling plans own it.
- **Deleting the browser tools or prompt.** The fix panel still uses them, and they are the parity reference.
- **Multi-line regex search.** See the Task 4 TRAP.
- **Rendering `search_text` results as text.** The browser has no renderer for it either; add one to both sides together, later.
