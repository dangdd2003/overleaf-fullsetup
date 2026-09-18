# AI Assist LLM Harness WS-B: Tools Implementation Plan

> **For agentic workers:** Implement task by task, in order. Steps use checkbox (`- [ ]`) syntax; tick each step when done. Every piece of code you need is in this file. Do not redesign anything. If a quoted "current code" block does not match the file, re-read the file and apply the change to the equivalent code.

**Goal:** Make the AI Assist tools give the model more understanding for fewer tokens, and stop them from acting on the wrong text or the wrong file: compact, correct compile diagnostics; bounded file reads; edit results that say where the edit landed; edit planning on live text; no silent fuzzy jumps to other files; exact path resolution; append guarded by the tool instead of the system prompt; a leaner tool list.

**Architecture:** The main chat's tools run on the server in `modules/ai-assist/app/src/AiAssistTools.mjs`. The model sees their results through `AiAssistToolRender.mjs` (structured result → compact text). The one-click fix run uses the browser tools in `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/*.ts`. Where the browser has the same defect, the same task fixes it. The system prompt exists twice and must stay byte-identical: `app/src/AiAssistSystemPrompt.mjs` and `frontend/js/features/ai-assist/agent/context/system-prompt.ts` (a test enforces this).

**Tech Stack:** Node.js ES modules, TypeScript tool modules, Vitest (backend), Mocha (frontend), Chai, Sinon.

**Order:** WS-A and WS-B can run in parallel (different files). WS-C runs after WS-A. WS-B does not depend on WS-A or WS-C.

---

## Global Constraints

- **Never run `git commit`, `git push`, `git stash`, `git checkout -- <file>`, `git restore`, or any history-altering git command.** Leave all changes uncommitted. `git checkout`/`git restore` would also wipe other uncommitted work in these files.
- **Another session may edit this worktree.** Line numbers were verified on 2026-09-17. If a quoted block does not match, find the equivalent code. Never overwrite unrelated edits.
- **Files this plan owns (edit only these):**
  - `modules/ai-assist/app/src/AiAssistTools.mjs`
  - `modules/ai-assist/app/src/AiAssistToolRender.mjs`
  - `modules/ai-assist/app/src/AiAssistSystemPrompt.mjs`
  - `modules/ai-assist/frontend/js/features/ai-assist/agent/context/system-prompt.ts`
  - `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-result.ts`
  - `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts`
  - `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts`
  - `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/search-text.ts`
  - `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts` (only one import, `toLastCompile`, `toCompileOutcome`)
  - tests under `modules/ai-assist/`: `test/unit/src/AiAssistTools.test.mjs`, `test/unit/src/AiAssistToolRender.test.mjs`, `test/frontend/js/agent/compile-log-tool.test.ts`, `test/frontend/js/agent/compile-tool.test.ts`, `test/frontend/js/agent/read-tools.test.ts`, `test/frontend/js/agent/edit-tool.test.ts`, `test/frontend/js/agent/tool-rendering.test.ts`
- **Do not touch** `AiAssistRunManager.mjs`, `run-agent.ts`, `context/budget.ts` (WS-C), or `AiAssistProviders.mjs`, `providers/types.ts` (WS-A).
- **Do not fix model behaviour by adding instructions to system prompts.** This plan *removes* a workaround from the prompt and moves the rule into the tool.
- **Working directory for all commands:**
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Backend test runner** (`XDG_DATA_HOME` is required):
  ```bash
  XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run <path> 2>&1 | grep -E "Test Files|Tests |FAIL|×|AssertionError" | head -40
  ```
- **Frontend runner for one or more files:**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --reporter dot <path> [<path>…] 2>&1 | grep -E "passing|failing|Error" | head -20
  ```
- **Frontend full module suite:**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' --reporter dot modules/ai-assist/test/frontend 2>&1 | grep -E "passing|failing"
  ```
- **Baseline (measured 2026-09-17):** backend `modules/ai-assist/test/unit/src` → 18 files, 212 passed. Frontend `modules/ai-assist/test/frontend` → 858 passing. Re-run both before Task 1 and write the numbers down.
- **Keep output small.** Always pipe test output through `grep`.
- **Style:** 2-space indentation, single quotes, no semicolons, trailing commas in multi-line literals.

### Test fixture facts (`AiAssistTools.test.mjs`, `beforeEach` at lines 16-106)

- `mockDocUpdater.getDocument(pid, docId)` returns `{ lines: ['line 1', 'line 2: target text', 'line 3'] }` for `doc-1`, and `{ lines: ['other file', 'no match here'] }` for any other id. There is no `flushProjectToMongo`, so the project snapshot fetches each document through `getDocument`.
- `mockEntityHandler.getAllDocs` resolves an **array**: `{ _id: 'doc-1', name: 'main.tex', path: 'main.tex' }`, `{ _id: 'doc-2', name: 'chapters/intro.tex', path: 'chapters/intro.tex' }`, `{ _id: 'doc-bib', name: 'references.bib', path: 'references.bib' }` (no `lines`).
- `mockEntityHandler.getDocIdByPath` resolves only `main.tex` → `doc-1` and `references.bib` → `doc-bib`; anything else → `null`.
- A valid user id is `'012345678901234567890123'`. `describe('edit planning')` and `describe('read_file limits')` define `const ctx = { projectId: 'p1', userId: '012345678901234567890123' }`.

---

## Background (verified findings this plan fixes)

1. **Compile diagnostics cost many tokens and are partly wrong.**
   - `compile_project` and `get_compile_result` have no renderer in `AiAssistToolRender.mjs`, so the model gets `JSON.stringify(result)`: `primaryError` repeats `errors[0]` including its excerpt, and every multi-line excerpt is JSON-escaped.
   - `excerptAround(rawLog, message)` (`AiAssistTools.mjs:481-490`) returns the lines around the **first** log line containing the message, so every "Undefined control sequence." gets the first one's context. The log parser already records each entry's own lines in `entry.raw` (`LatexLogParser.mjs:99, 211, 222`, extended with `content` at `:108-111, :139`).
   - `get_compile_result` also adds excerpts to **warnings** (`:1321-1331`).
   - The browser has the same defect: `tools/compile-result.ts:8-33` and `use-project-handle.ts:370-375`. Browser log entries come from the IDE parser, which also sets `raw` (`services/web/frontend/js/ide/log-parser/latex-log-parser.ts:28`).
2. **`get_compile_result` has a side effect.** With no remembered result it runs a full compile (`AiAssistTools.mjs:1297-1305`), although the loop treats it as read-only and may run it in parallel with other reads.
3. **Unbounded memory.** `this.lastCompileResult` (`:542`) keeps the full raw log of every project the process ever compiled (`:1253-1258`), never evicted.
4. **`read_file` without a range returns up to 1000 lines** (`MAX_READ_LINES`, `:21`, used at `:1044`). The result stays in the conversation and is re-sent on every later request. The browser tool does the same (`read-file.ts:52`; `project-handle.ts:178`).
5. **Edit results do not say where the edit landed.** `edit_file` returns `{ status: 'applied', path }` (`:1151`). After an edit that adds or removes lines, the line numbers the model read earlier are wrong below it, and a following `startLine`/`endLine` edit replaces the wrong lines. The model has to re-read the file to find out.
6. **Scoped anchor search reads the stored copy.** In `_planEdit`, `const docLines = doc.lines || (…)` (`:845`) uses `doc.lines` from `getAllDocs` (Mongo), not the live text in `docText`, but the match offset is applied to the live text. With unflushed typing the edit lands at the wrong offset. The same `if` (`:844`) ignores a `startLine` sent as a string, although `lineArg` (`:775`) accepts strings. In the test fixture `doc.lines` is `[]` (truthy), so numeric `startLine` scoping never worked there either.
7. **Silent fuzzy jump to another file.** When the anchor is not in the named file, `_planEdit` (`:871-891`) takes the first match of `locateAnchorInText` in **any** other document, including `fuzzy`, `whitespace` and `fuzzy_words` (75% word similarity) matches, fetching every document one request at a time.
8. **Loose path resolution.** `_resolveDoc` (`:724`) uses `d.path.endsWith(normalized) || normalized.endsWith(d.name)`. `a.tex` resolves to `data.tex`; `intro.tex` silently picks the first of several `intro.tex` files.
9. **A tool rule lives in the system prompt.** The prompt (`AiAssistSystemPrompt.mjs:74-79`, identical in `system-prompt.ts:74-79`) tells the model never to pass `oldText: ""` because appending lands after `\end{document}`. The noMatch errors repeat it (`AiAssistTools.mjs:927`, `edit-file.ts:181`). The tools themselves append after `\end{document}` without complaint.
10. **Tool list bloat sent on every request.** `configure_appearance_settings.editorTheme` lists 40 theme names (`:2021`); `list_available_settings` repeats font names (`:2135`); the system prompt repeats themes and fonts (`AiAssistSystemPrompt.mjs:63-68`); `search_text` has a `path` parameter documented as an alias of `glob` (`:1903-1906`).
11. **Search results print context out of order.** `AiAssistToolRender.mjs:86-92` (and the same code in `search-text.ts` `render`) prints the hit line, then the lines *before* it, then the lines after.

### Decisions (do not revisit)

- Error excerpts come from `entry.raw` **without its first line** (that line is the message, already shown), blank lines removed, at most 8 lines. Only when an entry has no `raw` does the browser fall back to `excerptAround`.
- Warnings never get excerpts.
- `includeRaw` keeps defaulting to `true` (excerpts are now short and correct). `includeRaw: false` strips excerpts.
- `primaryError` stays in the structured result (tests and callers read it). The text renderers never print it.
- `get_compile_result` never compiles. With nothing remembered it returns `{ status: 'none', message }`. WS-C stops counting `status: 'none'` as a failure.
- Remembered compiles: at most 100 projects (oldest evicted), no raw log stored, keyed by `String(projectId)`.
- `read_file` without `from`/`to`: at most **500** lines. With `from` or `to`: at most 1000, as before.
- An applied `edit_file` returns `startLine`, `endLine` (`null` when the edit only removed text), `lineDelta`, and `excerpt` (numbered lines from 3 above the change to 3 below it, at most 40 lines).
- An edit may move to another file only on an `exact` or `cleaned` match, confirmed against that file's live text.
- A partial path resolves only on whole path segments, and only when exactly one document matches. `read_file` names the candidates when a bare file name is ambiguous.
- Appending to a file that contains an uncommented `\end{document}` is refused by the tool, with an error naming the line. The prompt lines about it are deleted.
- The 5 settings tools stay (UI and `live-settings-updater.ts` depend on their names). Only their descriptions and the prompt section shrink. The server `search_text` schema drops `path` but execution still honours `args.path`. The browser `search_text` schema keeps `path` (pinned by `read-tools.test.ts:247-251`).
- `resolveEditTarget` (`AiAssistTools.mjs:671-701`) has no callers. Leave it alone.

---

## File Structure

| File | Change |
|---|---|
| `app/src/AiAssistTools.mjs` | new exports `errorExcerpt`, `describeAppliedEdit`, `endDocumentLine`; `_rememberCompile`; compile tools; read_file window; edit result; `_planEdit` fixes; `_resolveDoc`; specs |
| `app/src/AiAssistToolRender.mjs` | renderers for `compile_project`, `get_compile_result`, `edit_file`; search order |
| `app/src/AiAssistSystemPrompt.mjs` + `agent/context/system-prompt.ts` | delete the append workaround; shorten the settings section (identical edits in both) |
| `agent/tools/compile-result.ts`, `agent/use-project-handle.ts` | browser excerpts from `raw` |
| `agent/tools/read-file.ts` | 500-line default window |
| `agent/tools/edit-file.ts` | append guard; trimmed noMatch text |
| `agent/tools/search-text.ts` | render order |

---

### Task 1: Server compile diagnostics — own excerpts, no side effects, bounded memory, compact text

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs`
- Modify: `modules/ai-assist/app/src/AiAssistToolRender.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`, `modules/ai-assist/test/unit/src/AiAssistToolRender.test.mjs`

- [x] **Step 1: Write the failing tool tests**

In `AiAssistTools.test.mjs`, inside `describe('edit planning', …)`, directly after the test `'defaults includeRaw to true in get_compile_result'` (ends near line 978), add:
```js
    it('gives each error its own log excerpt, even when messages repeat', async function () {
      const validUserId = '012345678901234567890123'
      const log = [
        './main.tex:3: Undefined control sequence.',
        'l.3 \\foo',
        '',
        './main.tex:9: Undefined control sequence.',
        'l.9 \\bar',
      ].join('\n')
      tools.clsiManager = { getOutputFileStream: sinon.stub().resolves([Buffer.from(log)]) }
      mockCompileManager.compile.resolves({ status: 'failure', buildId: 'b1', clsiServerId: 's1', outputFiles: [{ path: 'output.log' }] })

      const res = await tools.execute('compile_project', {}, { projectId: 'p1', userId: validUserId })

      expect(res.errors).to.have.length(2)
      expect(res.errors[0].excerpt).to.equal('l.3 \\foo')
      expect(res.errors[1].excerpt).to.equal('l.9 \\bar')
    })

    it('never attaches excerpts to warnings and strips them when includeRaw is false', async function () {
      const validUserId = '012345678901234567890123'
      const log = [
        'LaTeX Warning: Reference `a` on page 1 undefined on input line 4.',
        './main.tex:3: Undefined control sequence.',
        'l.3 \\foo',
      ].join('\n')
      tools.clsiManager = { getOutputFileStream: sinon.stub().resolves([Buffer.from(log)]) }
      mockCompileManager.compile.resolves({ status: 'failure', buildId: 'b1', clsiServerId: 's1', outputFiles: [{ path: 'output.log' }] })
      await tools.execute('compile_project', {}, { projectId: 'p1', userId: validUserId })

      const all = await tools.execute('get_compile_result', {}, { projectId: 'p1', userId: validUserId })
      expect(all.warnings[0]).to.not.have.property('excerpt')
      expect(all.errors[0].excerpt).to.equal('l.3 \\foo')

      const bare = await tools.execute('get_compile_result', { includeRaw: false }, { projectId: 'p1', userId: validUserId })
      expect(bare.errors[0]).to.not.have.property('excerpt')
    })

    it('get_compile_result never compiles', async function () {
      const validUserId = '012345678901234567890123'
      const res = await tools.execute('get_compile_result', {}, { projectId: 'never-compiled', userId: validUserId })

      expect(res.status).to.equal('none')
      expect(res.message).to.include('compile_project')
      expect(mockCompileManager.compile.called).to.equal(false)
    })

    it('remembers compiles for at most 100 projects and keeps no raw log', async function () {
      const validUserId = '012345678901234567890123'
      for (let index = 0; index <= 100; index++) {
        await tools.execute('compile_project', {}, { projectId: `p${index}`, userId: validUserId })
      }

      expect(tools.lastCompileResult.size).to.equal(100)
      expect(tools.lastCompileResult.has('p0')).to.equal(false)
      expect(tools.lastCompileResult.get('p100')).to.not.have.property('rawLog')
    })
```
Note: the default `mockCompileManager.compile` resolves `{ status: 'success', outputFiles: [] }`, so the 101 compiles read no log and are fast.

- [x] **Step 2: Write the failing renderer tests**

In `AiAssistToolRender.test.mjs`, replace the test `'keeps errors and unknown tools as JSON'`:
```js
  it('keeps errors and unknown tools as JSON', function () {
    expect(renderToolResult('read_file', { error: 'File not found: x' })).to.equal('{"error":"File not found: x"}')
    expect(renderToolResult('compile_project', { status: 'success' })).to.equal('{"status":"success"}')
    expect(renderToolResult('read_file', null)).to.equal('null')
  })
```
with:
```js
  it('keeps errors and unknown tools as JSON', function () {
    expect(renderToolResult('read_file', { error: 'File not found: x' })).to.equal('{"error":"File not found: x"}')
    expect(renderToolResult('compile_project', { status: 'success' })).to.equal('{"status":"success"}')
    expect(renderToolResult('no_such_tool', { a: 1 })).to.equal('{"a":1}')
    expect(renderToolResult('read_file', null)).to.equal('null')
  })

  it('renders compile_project as compact text without repeating the primary error', function () {
    const error = { file: 'main.tex', line: 3, message: 'Undefined control sequence.', excerpt: 'l.3 \\foo' }
    const text = renderToolResult('compile_project', {
      status: 'failure',
      errorCount: 2,
      warningCount: 1,
      message: 'The project compiled with 2 error(s) and 1 warning(s).',
      primaryError: error,
      errors: [error, { file: null, line: null, message: 'Emergency stop.' }],
      warnings: [{ file: 'main.tex', line: null, message: 'Label(s) may have changed.' }],
    })
    expect(text).to.equal([
      'The project compiled with 2 error(s) and 1 warning(s).',
      'Errors after the first often cascade from it.',
      'error main.tex:3: Undefined control sequence.',
      '    l.3 \\foo',
      'error unknown location: Emergency stop.',
      'warning main.tex: Label(s) may have changed.',
    ].join('\n'))
  })

  it('says how many diagnostics compile_project left out', function () {
    const text = renderToolResult('compile_project', {
      status: 'failure',
      errorCount: 25,
      warningCount: 0,
      message: 'm',
      errors: [{ file: 'a.tex', line: 1, message: 'x' }],
      warnings: [],
    })
    expect(text).to.include('(24 more error(s) and 0 more warning(s) not shown; call get_compile_result with a higher limit)')
  })

  it('renders get_compile_result, including the nothing-compiled case', function () {
    expect(renderToolResult('get_compile_result', { status: 'none', message: 'No compile yet.' })).to.equal('No compile yet.')
    expect(renderToolResult('get_compile_result', {
      status: 'success',
      errorCount: 0,
      warningCount: 1,
      errors: [],
      warnings: [{ file: 'main.tex', line: 7, message: 'Overfull \\hbox' }],
      truncated: false,
    })).to.equal('Last compile: success - 0 error(s), 1 warning(s)\nwarning main.tex:7: Overfull \\hbox')
  })
```

- [x] **Step 3: Run both files to verify the new tests fail**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs modules/ai-assist/test/unit/src/AiAssistToolRender.test.mjs 2>&1 | grep -E "Tests |×|FAIL" | head -20
```
Expected: the 4 new tool tests and 3 new renderer tests fail.

- [x] **Step 4: Replace `excerptAround` with `errorExcerpt`**

In `AiAssistTools.mjs`, replace exactly (lines 481-490):
```js
function excerptAround(rawLog, needle, radius = 3) {
  if (!rawLog || !needle) return null
  const lines = rawLog.split('\n')
  const index = lines.findIndex(line => line.includes(needle))
  if (index === -1) return null

  return lines
    .slice(Math.max(0, index - radius), index + radius + 1)
    .join('\n')
}
```
with:
```js
const MAX_EXCERPT_LINES = 8

/**
 * The log lines TeX printed for one parsed error (`l.12 \foo` and friends),
 * taken from the entry itself rather than searched for in the whole log, so
 * two errors with the same message each keep their own context. The first raw
 * line is the message, which the caller already shows.
 */
export function errorExcerpt(entry) {
  if (!entry || typeof entry.raw !== 'string') return null
  const lines = entry.raw
    .split('\n')
    .slice(1)
    .filter(line => line.trim() !== '')
    .slice(0, MAX_EXCERPT_LINES)
  return lines.length > 0 ? lines.join('\n') : null
}
```

- [x] **Step 5: Add the memory limit**

(a) Replace exactly:
```js
const MAX_SEARCH_HITS = 50
```
with:
```js
const MAX_SEARCH_HITS = 50
const MAX_REMEMBERED_COMPILES = 100
```

(b) Replace exactly:
```js
  invalidateSnapshot(projectId) {
```
with:
```js
  /** Keeps the newest compile per project, for at most MAX_REMEMBERED_COMPILES projects. */
  _rememberCompile(projectId, value) {
    const key = String(projectId)
    this.lastCompileResult.delete(key)
    this.lastCompileResult.set(key, value)
    while (this.lastCompileResult.size > MAX_REMEMBERED_COMPILES) {
      this.lastCompileResult.delete(this.lastCompileResult.keys().next().value)
    }
  }

  invalidateSnapshot(projectId) {
```

- [x] **Step 6: Update `compile_project`**

(a) Replace exactly:
```js
        let errors = []
        let warnings = []
        let rawLog = ''
```
with:
```js
        let errors = []
        let warnings = []
```

(b) Replace exactly:
```js
            rawLog = Buffer.concat(chunks).toString('utf8')
            const parsed = LatexLogParser.parse(rawLog, { ignoreDuplicates: true })
            errors = (parsed.errors || []).map(e => {
              const summary = {
                file: e.file || null,
                line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
                message: e.message || '',
              }
              if (rawLog && summary.message) {
                const excerpt = excerptAround(rawLog, summary.message, 3)
                if (excerpt) summary.excerpt = excerpt
              }
              return summary
            })
```
with:
```js
            const rawLog = Buffer.concat(chunks).toString('utf8')
            const parsed = LatexLogParser.parse(rawLog, { ignoreDuplicates: true })
            errors = (parsed.errors || []).map(e => {
              const summary = {
                file: e.file || null,
                line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
                message: e.message || '',
              }
              const excerpt = errorExcerpt(e)
              if (excerpt) summary.excerpt = excerpt
              return summary
            })
```

(c) Replace exactly:
```js
        const previous = this.lastCompileResult.get(projectId)
        const previousErrors = previous?.errors || []

        this.lastCompileResult.set(projectId, {
          status: compileStatus,
          errors,
          warnings,
          rawLog,
        })
```
with:
```js
        const previous = this.lastCompileResult.get(String(projectId))
        const previousErrors = previous?.errors || []

        this._rememberCompile(projectId, {
          status: compileStatus,
          errors,
          warnings,
        })
```

- [x] **Step 7: Replace `get_compile_result`**

Replace the whole case: from the line `      case 'get_compile_result':` down to and including the closing `}` after `return outcome` (currently lines 1295-1352). The current block begins:
```js
      case 'get_compile_result':
      case 'get_compile_log': {
        let compile = this.lastCompileResult.get(projectId)
        if (!compile) {
          try {
            await this.execute('compile_project', {}, { projectId, userId: rawUserId })
```
and ends:
```js
        if (severity === 'all' || severity === 'warnings') {
          outcome.warnings = decoratedWarnings
        }

        return outcome
      }
```
Replace it with:
```js
      case 'get_compile_result':
      case 'get_compile_log': {
        // Reads only. Compiling here would make a "read" slow, and reads can
        // run in parallel with each other.
        const compile = this.lastCompileResult.get(String(projectId))
        if (!compile) {
          return {
            status: 'none',
            message: 'No compile has run in this chat yet. Call compile_project to build the project.',
          }
        }

        const severity = args.severity || 'all'
        const requestedLimit = Number(args.limit || args.maxEntries)
        const limit = requestedLimit > 0 ? Math.floor(requestedLimit) : 20
        const includeRaw = args.includeRaw !== false && args.includeRaw !== 'false'

        const errors = compile.errors.slice(0, limit).map(entry => {
          if (includeRaw || !entry.excerpt) return entry
          const copy = { ...entry }
          delete copy.excerpt
          return copy
        })
        const warnings = compile.warnings.slice(0, limit)

        const outcome = {
          status: compile.status,
          errorCount: compile.errors.length,
          warningCount: compile.warnings.length,
          primaryError: errors.length > 0 ? errors[0] : null,
          cascadingErrorsCount: Math.max(0, compile.errors.length - 1),
          truncated: compile.errors.length > limit || compile.warnings.length > limit,
        }

        if (severity === 'all' || severity === 'errors') {
          outcome.errors = errors
        }
        if (severity === 'all' || severity === 'warnings') {
          outcome.warnings = warnings
        }

        return outcome
      }
```
TRAP: do not remove the `userId: rawUserId` parameter from `execute`'s signature; other code in `execute` may use it.
CHECK: run `grep -n "excerptAround\|rawLog" modules/ai-assist/app/src/AiAssistTools.mjs`. After Steps 4-7 the only hits must be the `const rawLog = Buffer.concat(…)` line and `LatexLogParser.parse(rawLog, …)`. Any other hit is leftover code.

- [x] **Step 8: Update the `get_compile_result` spec**

Replace exactly:
```js
        description: 'Get the result of the last project compilation: errors, warnings and diagnostics.',
```
with:
```js
        description: 'The errors and warnings of the last compile_project in this chat, without rebuilding.',
```
and replace exactly:
```js
              description: 'Include raw log lines around each entry',
```
with:
```js
              description: 'Include the TeX log lines of each error. Defaults to true.',
```

- [x] **Step 9: Add the renderers**

In `AiAssistToolRender.mjs`, replace exactly:
```js
function outlineLine(section) {
  return `${'  '.repeat(section.level + 1)}${section.path}:${section.line} ${section.title}`
}
```
with:
```js
function outlineLine(section) {
  return `${'  '.repeat(section.level + 1)}${section.path}:${section.line} ${section.title}`
}

function location(entry) {
  if (!entry.file) return 'unknown location'
  return entry.line ? `${entry.file}:${entry.line}` : entry.file
}

function diagnosticLines(result) {
  const lines = []
  for (const error of result.errors || []) {
    lines.push(`error ${location(error)}: ${error.message}`)
    if (error.excerpt) {
      lines.push(...error.excerpt.split('\n').map(line => `    ${line}`))
    }
  }
  for (const warning of result.warnings || []) {
    lines.push(`warning ${location(warning)}: ${warning.message}`)
  }
  return lines
}
```
Then inside `const RENDERERS = {`, directly before `  get_outline(result) {`, add:
```js
  compile_project(result) {
    if (typeof result.errorCount !== 'number') return JSON.stringify(result)
    const lines = [
      result.message ||
        `Compile ${result.status}: ${result.errorCount} error(s), ${result.warningCount} warning(s).`,
    ]
    if (result.errorCount > 1) lines.push('Errors after the first often cascade from it.')
    lines.push(...diagnosticLines(result))
    const hiddenErrors = result.errorCount - (result.errors?.length ?? 0)
    const hiddenWarnings = (result.warningCount ?? 0) - (result.warnings?.length ?? 0)
    if (hiddenErrors > 0 || hiddenWarnings > 0) {
      lines.push(
        `(${hiddenErrors} more error(s) and ${hiddenWarnings} more warning(s) not shown; call get_compile_result with a higher limit)`
      )
    }
    return lines.join('\n')
  },

  get_compile_result(result) {
    if (result.status === 'none' && result.message) return result.message
    if (typeof result.errorCount !== 'number') return JSON.stringify(result)
    const lines = [
      `Last compile: ${result.status} - ${result.errorCount} error(s), ${result.warningCount} warning(s)`,
    ]
    if (result.errorCount > 1) lines.push('Errors after the first often cascade from it.')
    lines.push(...diagnosticLines(result))
    if (result.truncated) lines.push('(more entries not shown; pass a higher limit)')
    return lines.join('\n')
  },

```

- [x] **Step 10: Run to verify everything passes**

Same command as Step 3. Expected: all tests in both files pass, including the existing `'compiles project and parses output.log…'`, `'reports error deltas and regressed flag…'` and `'defaults includeRaw to true in get_compile_result'`.

---

### Task 2: Browser compile diagnostics use each entry's own log lines

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-result.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts` (import at line 13; `toLastCompile` lines 244-265; the errors map in `toCompileOutcome`, lines 364-377)
- Test: `modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts`, `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts`

- [x] **Step 1: Write the failing tests**

(a) In `compile-log-tool.test.ts`, change the import at the top from:
```ts
import {
  compileResultTool,
  excerptAround,
} from '../../../../frontend/js/features/ai-assist/agent/tools/compile-result'
```
to:
```ts
import {
  compileResultTool,
  errorExcerpt,
  excerptAround,
} from '../../../../frontend/js/features/ai-assist/agent/tools/compile-result'
```
Add these two tests at the end of `describe('get_compile_result', …)`, just before its closing `})`:
```ts
  it('never attaches excerpts to warnings', async function () {
    const compile = {
      ...COMPILE,
      warnings: [{ message: 'Undefined control sequence.', file: 'main.tex', line: 3 }],
    }
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: compile })
    const result: any = await compileResultTool.execute({}, handle)

    expect(result.warnings[0].excerpt).to.equal(undefined)
  })

  it('strips excerpts the entries already carry when includeRaw is false', async function () {
    const compile = {
      ...COMPILE,
      errors: [{ ...COMPILE.errors[0], excerpt: 'l.3 \\foo' }],
    }
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: compile })
    const result: any = await compileResultTool.execute({ includeRaw: false }, handle)

    expect(result.errors[0].excerpt).to.equal(undefined)
  })
```
Then add a new top-level block at the end of the file:
```ts
describe('errorExcerpt', function () {
  it('returns the log lines after the message line, without blanks', function () {
    expect(errorExcerpt({ raw: '! Undefined control sequence.\n\nl.3 \\foo\n' })).to.equal('l.3 \\foo')
  })

  it('returns null without raw context', function () {
    expect(errorExcerpt({ raw: '! Emergency stop.\n' })).to.equal(null)
    expect(errorExcerpt({})).to.equal(null)
  })
})
```

(b) In `compile-tool.test.ts`, inside `describe('toCompileOutcome', …)` (starts line 262), add:
```ts
  it('takes each error excerpt from its own raw lines, so repeated messages keep their context', function () {
    const rawLog = '! Undefined control sequence.\nl.3 \\foo\n\n! Undefined control sequence.\nl.9 \\bar\n'
    const entries = {
      errors: [
        { message: 'Undefined control sequence.', file: 'main.tex', line: 3, raw: '! Undefined control sequence.\nl.3 \\foo\n' },
        { message: 'Undefined control sequence.', file: 'main.tex', line: 9, raw: '! Undefined control sequence.\nl.9 \\bar\n' },
      ],
      warnings: [],
    }

    const outcome = toCompileOutcome(entries, rawLog)

    expect(outcome.errors[0].excerpt).to.equal('l.3 \\foo')
    expect(outcome.errors[1].excerpt).to.equal('l.9 \\bar')
  })
```

- [x] **Step 2: Run to verify they fail**
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --reporter dot modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts 2>&1 | grep -E "passing|failing|Error" | head -20
```
Expected: failures (`errorExcerpt` not exported; excerpt assertions).

- [x] **Step 3: Implement in `compile-result.ts`**

(a) Replace exactly:
```ts
function decorate(
  entries: LogEntrySummary[],
  rawLog: string | null,
  includeRaw: boolean
) {
  if (!includeRaw || !rawLog) return entries
  return entries.map(entry => {
```
with:
```ts
const MAX_EXCERPT_LINES = 8

/**
 * The log lines TeX printed for one parsed error, from the entry's own `raw`
 * text. Searching the whole log by message instead gives every repeated
 * message ("Undefined control sequence.") the first one's context. The first
 * raw line is the message itself, which is already shown.
 */
export function errorExcerpt(entry: { raw?: unknown }): string | null {
  if (!entry || typeof entry.raw !== 'string') return null
  const lines = entry.raw
    .split('\n')
    .slice(1)
    .filter(line => line.trim() !== '')
    .slice(0, MAX_EXCERPT_LINES)
  return lines.length > 0 ? lines.join('\n') : null
}

function decorate(
  entries: LogEntrySummary[],
  rawLog: string | null,
  includeRaw: boolean
) {
  if (!includeRaw) {
    return entries.map(entry => {
      if (!entry.excerpt) return entry
      const copy = { ...entry }
      delete copy.excerpt
      return copy
    })
  }
  if (!rawLog) return entries
  return entries.map(entry => {
```

(b) Replace exactly:
```ts
    const decoratedWarnings = decorate(rawWarnings, compile.rawLog, includeRaw)
```
with:
```ts
    // Warnings carry no excerpt: the message is the whole log entry.
    const decoratedWarnings = rawWarnings
```

(c) Replace exactly:
```ts
          description: 'Include raw log lines around each entry. Defaults to true.',
```
with:
```ts
          description: 'Include the TeX log lines of each error. Defaults to true.',
```

- [x] **Step 4: Implement in `use-project-handle.ts`**

(a) Replace exactly:
```ts
import { excerptAround } from './tools/compile-result'
```
with:
```ts
import { errorExcerpt, excerptAround } from './tools/compile-result'
```

(b) In `toLastCompile`, replace exactly:
```ts
  const errors: LogEntrySummary[] = (entries.errors ?? []).map((e: any) => ({
    message: e.message ?? '',
    file: e.file ?? null,
    line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
  }))
```
with:
```ts
  const errors: LogEntrySummary[] = (entries.errors ?? []).map((e: any) => {
    const summary: LogEntrySummary = {
      message: e.message ?? '',
      file: e.file ?? null,
      line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
    }
    const excerpt = errorExcerpt(e)
    if (excerpt) summary.excerpt = excerpt
    return summary
  })
```

(c) In `toCompileOutcome`, replace exactly:
```ts
    if (rawLog && summary.message) {
      const excerpt = excerptAround(rawLog, summary.message, 3)
      if (excerpt) {
        summary.excerpt = excerpt
      }
    }
```
with:
```ts
    const excerpt =
      errorExcerpt(e) ??
      (rawLog && summary.message ? excerptAround(rawLog, summary.message, 3) : null)
    if (excerpt) {
      summary.excerpt = excerpt
    }
```

- [x] **Step 5: Run to verify they pass**

Same command as Step 2. Expected: 0 failing. The existing `'attaches raw log excerpts by default'`, `'omits raw log excerpts when explicitly passed includeRaw: false'` and `'attaches raw log excerpts to error summaries when rawLog is provided'` still pass: their entries have no `raw`, so the `excerptAround` fallback is used.

---

### Task 3: `read_file` without a range reads a 500-line window

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (constant near line 21; `read_file` case lines 1041-1048; `read_file` spec line 1880)
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts`
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs` (`describe('read_file limits')`, line 705), `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts`

- [x] **Step 1: Update and add the server tests**

In `describe('read_file limits', …)`, replace the whole test `'caps a long read at 1000 lines and says where to continue'` with:
```js
    it('reads at most 500 lines when no range is given and says where to continue', async function () {
      const lines = Array.from({ length: 1500 }, (_, i) => `l${i + 1}`)
      mockDocUpdater.getDocument = sinon.stub().resolves({ lines })

      const res = await tools.execute('read_file', { path: 'main.tex' }, ctx)

      expect(res.from).to.equal(1)
      expect(res.to).to.equal(500)
      expect(res.totalLines).to.equal(1500)
      expect(res.truncated).to.equal(true)
      expect(res.nextRange).to.deep.equal({ from: 501, to: 1000 })
      expect(res.content.split('\n')[499]).to.equal('500: l500')
    })

    it('caps an explicit range at 1000 lines', async function () {
      const lines = Array.from({ length: 1500 }, (_, i) => `l${i + 1}`)
      mockDocUpdater.getDocument = sinon.stub().resolves({ lines })

      const res = await tools.execute('read_file', { path: 'main.tex', from: 1, to: 1500 }, ctx)

      expect(res.to).to.equal(1000)
      expect(res.nextRange).to.deep.equal({ from: 1001, to: 1500 })
    })
```

- [x] **Step 2: Add the browser test**

In `read-tools.test.ts`, add inside the top-level `describe` that contains `'search_text returns path, line and text'` (any `it` position is fine, e.g. right after that test):
```ts
  it('read_file reads at most 500 lines when no range is given', async function () {
    const text = Array.from({ length: 1200 }, (_, i) => `l${i + 1}`).join('\n')
    const { handle } = createFakeHandle({ docs: { 'long.tex': text } })

    const result: any = await readFileTool.execute({ path: 'long.tex' }, handle)

    expect(result.to).to.equal(500)
    expect(result.nextRange).to.deep.equal({ from: 501, to: 1000 })

    const ranged: any = await readFileTool.execute({ path: 'long.tex', from: 1, to: 1200 }, handle)
    expect(ranged.to).to.equal(1000)
  })
```
(`readFileTool` and `createFakeHandle` are already imported in this file.)

TRAP: the existing test `'names the next range to request when it truncates'` (line 133) reads a `MAX_READ_LINES + 50`-line file **without** a range and expects the 1000-line cap. After this task a range-less read stops at 500. Keep that test about the explicit-range cap by changing its call from:
```ts
    const result: any = await readFileTool.execute({ path: 'big.tex' }, handle)
```
to:
```ts
    const result: any = await readFileTool.execute({ path: 'big.tex', from: 1 }, handle)
```
Its expectations stay unchanged.

- [x] **Step 3: Run to verify they fail**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs 2>&1 | grep -E "Tests |×" | head
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --reporter dot modules/ai-assist/test/frontend/js/agent/read-tools.test.ts 2>&1 | grep -E "passing|failing" 
```
Expected: the 500-line tests fail (they get 1000).

- [x] **Step 4: Implement on the server**

(a) Replace exactly:
```js
const MAX_READ_LINES = 1000
```
with:
```js
const MAX_READ_LINES = 1000
// Without from/to, read_file returns a window instead of a whole long file:
// the result stays in the conversation and is re-sent on every later step.
const DEFAULT_READ_LINES = 500
```

(b) Replace exactly:
```js
        const totalLines = lines.length
        const start = Math.max(1, Math.min(Number(args.from) || 1, totalLines || 1))
        const requestedEnd = Math.min(Number(args.to) || totalLines, totalLines)
        const capped = lines.slice(start - 1, requestedEnd).slice(0, MAX_READ_LINES)
        const end = start + capped.length - 1
        const nextRange = end < totalLines
          ? { from: end + 1, to: Math.min(end + MAX_READ_LINES, totalLines) }
          : undefined
```
with:
```js
        const totalLines = lines.length
        const hasRange = Number(args.from) > 0 || Number(args.to) > 0
        const windowSize = hasRange ? MAX_READ_LINES : DEFAULT_READ_LINES
        const start = Math.max(1, Math.min(Number(args.from) || 1, totalLines || 1))
        const requestedEnd = Math.min(Number(args.to) || totalLines, totalLines)
        const capped = lines.slice(start - 1, requestedEnd).slice(0, windowSize)
        const end = start + capped.length - 1
        const nextRange = end < totalLines
          ? { from: end + 1, to: Math.min(end + windowSize, totalLines) }
          : undefined
```

(c) In `getToolSpecs`, replace exactly:
```js
          'Read one text file, or a line range of one, as numbered lines. Get the range from get_outline or search_text first rather than guessing it.',
```
with:
```js
          'Read one text file, or a line range of one, as numbered lines. Without from/to it returns the first 500 lines. Get the range from get_outline or search_text first rather than guessing it.',
```

- [x] **Step 5: Implement in the browser**

In `frontend/js/features/ai-assist/agent/tools/read-file.ts`:

(a) Replace exactly:
```ts
function number(lines: string[], offset: number) {
```
with:
```ts
/** Without from/to, read a window: the result is re-sent on every later step. */
const DEFAULT_READ_LINES = 500

function number(lines: string[], offset: number) {
```

(b) Replace exactly:
```ts
    const start = Math.max(1, from ?? 1)
    const requestedEnd = Math.min(to ?? totalLines, totalLines)
    const capped = lines.slice(start - 1, requestedEnd).slice(0, MAX_READ_LINES)
    const end = start + capped.length - 1

    const nextRange =
      end < totalLines
        ? { from: end + 1, to: Math.min(end + MAX_READ_LINES, totalLines) }
        : undefined
```
with:
```ts
    const windowSize =
      from !== undefined || to !== undefined ? MAX_READ_LINES : DEFAULT_READ_LINES
    const start = Math.max(1, from ?? 1)
    const requestedEnd = Math.min(to ?? totalLines, totalLines)
    const capped = lines.slice(start - 1, requestedEnd).slice(0, windowSize)
    const end = start + capped.length - 1

    const nextRange =
      end < totalLines
        ? { from: end + 1, to: Math.min(end + windowSize, totalLines) }
        : undefined
```

- [x] **Step 6: Run to verify they pass**

Same commands as Step 3. Expected: 0 failures.

---

### Task 4: An applied edit reports where it landed

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (new export after `errorExcerpt`; the four successful `return`s of `_planEdit`; `edit_file` case at line 1146)
- Modify: `modules/ai-assist/app/src/AiAssistToolRender.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`, `modules/ai-assist/test/unit/src/AiAssistToolRender.test.mjs`

- [x] **Step 1: Write the failing tests**

(a) In `AiAssistTools.test.mjs`, `describe('edit planning')`, replace the test `'edit_file deletes a line range without oldText'`:
```js
    it('edit_file deletes a line range without oldText', async function () {
      const res = await tools.execute('edit_file', { path: 'main.tex', startLine: 2, endLine: 3, newText: '' }, ctx)
      expect(res.status).to.equal('applied')
      expect(mockDocUpdater.setDocument.firstCall.args[3]).to.deep.equal(['line 1'])
    })
```
with:
```js
    it('edit_file deletes a line range without oldText', async function () {
      const res = await tools.execute('edit_file', { path: 'main.tex', startLine: 2, endLine: 3, newText: '' }, ctx)
      expect(res.status).to.equal('applied')
      expect(mockDocUpdater.setDocument.firstCall.args[3]).to.deep.equal(['line 1'])
      expect(res).to.include({ startLine: 2, endLine: null, lineDelta: -2, excerpt: '1: line 1' })
    })

    it('edit_file reports the new line range, the line shift and the lines around it', async function () {
      const res = await tools.execute('edit_file', { path: 'main.tex', oldText: 'target text', newText: 'a\nb' }, ctx)

      expect(res.status).to.equal('applied')
      expect(res).to.include({ path: 'main.tex', startLine: 2, endLine: 3, lineDelta: 1 })
      expect(res.excerpt).to.equal('1: line 1\n2: line 2: a\n3: b\n4: line 3')
    })
```

(b) In `AiAssistToolRender.test.mjs`, add:
```js
  it('renders an applied edit with its new line numbers and the shift below it', function () {
    expect(renderToolResult('edit_file', {
      status: 'applied',
      path: 'main.tex',
      startLine: 2,
      endLine: 3,
      lineDelta: 1,
      excerpt: '1: line 1\n2: a\n3: b\n4: line 3',
    })).to.equal(
      'Applied to main.tex, now lines 2-3. Later lines moved by +1; use these line numbers, not ones read before this edit.\n```\n1: line 1\n2: a\n3: b\n4: line 3\n```'
    )

    expect(renderToolResult('edit_file', {
      status: 'applied',
      path: 'main.tex',
      startLine: 2,
      endLine: null,
      lineDelta: -2,
      excerpt: '1: line 1',
    })).to.equal(
      'Applied to main.tex, removed text at line 2. Later lines moved by -2; use these line numbers, not ones read before this edit.\n```\n1: line 1\n```'
    )

    expect(renderToolResult('edit_file', { status: 'noMatch', error: 'x' })).to.equal('{"status":"noMatch","error":"x"}')
  })
```

- [x] **Step 2: Run to verify they fail**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs modules/ai-assist/test/unit/src/AiAssistToolRender.test.mjs 2>&1 | grep -E "Tests |×" | head
```

- [x] **Step 3: Add `previousLineCount` to every successful plan**

`_planEdit` has four successful `return`s. Change each one:

(a) Line-range mode. Replace exactly:
```js
          oldText: rangeText,
          newText: rangeNewText,
          startLine: from,
        }
```
with:
```js
          oldText: rangeText,
          newText: rangeNewText,
          startLine: from,
          previousLineCount: docLines.length,
        }
```

(b) Whole-file replacement. Replace exactly:
```js
      return { doc, lines: updatedLines, path: doc.path, oldText: args.oldText, newText: sanitizedNewText, startLine: 1 }
```
with:
```js
      return { doc, lines: updatedLines, path: doc.path, oldText: args.oldText, newText: sanitizedNewText, startLine: 1, previousLineCount: docText.split('\n').length }
```

(c) Append. Replace exactly:
```js
      return { doc, lines: appended.split('\n'), path: doc.path, oldText: '', newText: sanitizedNewText, startLine }
```
with:
```js
      return { doc, lines: appended.split('\n'), path: doc.path, oldText: '', newText: sanitizedNewText, startLine, previousLineCount: docText.split('\n').length }
```

(d) Anchor replacement (the last `return` of `_planEdit`). Replace exactly:
```js
      oldText: resolvedOldText,
      newText: sanitizedNewText,
      startLine,
    }
```
with:
```js
      oldText: resolvedOldText,
      newText: sanitizedNewText,
      startLine,
      previousLineCount: resolvedDocText.split('\n').length,
    }
```

- [x] **Step 4: Add `describeAppliedEdit`**

In `AiAssistTools.mjs`, directly after the `errorExcerpt` function added in Task 1, add:
```js

const EDIT_CONTEXT_LINES = 3
const MAX_EDIT_EXCERPT_LINES = 40

/**
 * Where an applied edit landed, in the document as it is now. Line numbers the
 * model read before the edit are stale below it; the new range, the shift and
 * the numbered lines around the change let it chain further edits without
 * reading the file again.
 */
export function describeAppliedEdit(plan) {
  const startLine = Math.max(1, plan.startLine || 1)
  const newSpan = plan.newText ? plan.newText.split('\n').length : 0
  const endLine = newSpan > 0 ? startLine + newSpan - 1 : null
  const from = Math.max(1, startLine - EDIT_CONTEXT_LINES)
  const to = Math.min(
    plan.lines.length,
    (endLine ?? startLine) + EDIT_CONTEXT_LINES,
    from + MAX_EDIT_EXCERPT_LINES - 1
  )
  return {
    startLine,
    endLine,
    lineDelta:
      typeof plan.previousLineCount === 'number'
        ? plan.lines.length - plan.previousLineCount
        : 0,
    excerpt: plan.lines
      .slice(from - 1, to)
      .map((line, index) => `${from + index}: ${line}`)
      .join('\n'),
  }
}
```

- [x] **Step 5: Return it from `edit_file`**

Replace exactly:
```js
        return { status: 'applied', path: plan.path, ...(plan.note ? { note: plan.note } : {}) }
```
with:
```js
        return {
          status: 'applied',
          path: plan.path,
          ...describeAppliedEdit(plan),
          ...(plan.note ? { note: plan.note } : {}),
        }
```

- [x] **Step 6: Add the renderer**

In `AiAssistToolRender.mjs`, inside `const RENDERERS = {`, directly before `  get_outline(result) {`, add:
```js
  edit_file(result) {
    if (result.status !== 'applied' || typeof result.startLine !== 'number') {
      return JSON.stringify(result)
    }
    const where = result.endLine
      ? `now lines ${result.startLine}-${result.endLine}`
      : `removed text at line ${result.startLine}`
    const shift = result.lineDelta
      ? ` Later lines moved by ${result.lineDelta > 0 ? '+' : ''}${result.lineDelta}; use these line numbers, not ones read before this edit.`
      : ''
    const note = result.note ? ` ${result.note}` : ''
    const header = `Applied to ${result.path}, ${where}.${shift}${note}`
    return result.excerpt ? [header, '```', result.excerpt, '```'].join('\n') : header
  },

```

- [x] **Step 7: Run to verify they pass**

Same command as Step 2. Expected: all pass, including `'sanitizes line-number prefixes from newText in edit_file'` and `'checkEdit resolves a line range to the text it replaces, and re-applies from that'`.

---

### Task 5: Scoped anchor search uses the live text and accepts numbers sent as strings

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (`_planEdit`, lines 843-861)
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`

- [x] **Step 1: Write the failing tests**

In `describe('edit planning')`, add:
```js
    it('checkEdit uses startLine to pick one of two identical anchors', async function () {
      mockDocUpdater.getDocument = sinon.stub().resolves({ lines: ['a', 'dup', 'b', 'dup'] })

      const res = await tools.checkEdit({ path: 'main.tex', oldText: 'dup', newText: 'X', startLine: 4 }, ctx)

      expect(res.status).to.equal('ok')
      expect(res.startLine).to.equal(4)
    })

    it('checkEdit accepts startLine sent as a string', async function () {
      mockDocUpdater.getDocument = sinon.stub().resolves({ lines: ['a', 'dup', 'b', 'dup'] })

      const res = await tools.checkEdit({ path: 'main.tex', oldText: 'dup', newText: 'X', startLine: '4' }, ctx)

      expect(res.status).to.equal('ok')
      expect(res.startLine).to.equal(4)
    })
```
Why they fail today: `getAllDocs` in the fixture has no `lines`, so `doc.lines` is `[]` and the scoped search never sees the live text; a string `startLine` is ignored entirely. Both end as `ambiguous`.

- [x] **Step 2: Run to verify they fail**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs 2>&1 | grep -E "Tests |×" | head
```

- [x] **Step 3: Implement**

Replace exactly:
```js
    // Constrain search range if startLine is provided
    if (typeof args.startLine === 'number' && args.startLine >= 1 && doc) {
      const docLines = doc.lines || (docText ? docText.split('\n') : [])
      const startIdx = args.startLine - 1
      const anchorLineCount = targetAnchor.split('\n').length
      const windowRadius = Math.max(2, anchorLineCount + 1)
      const localEndIdx = typeof args.endLine === 'number' && args.endLine >= args.startLine ? args.endLine : Math.min(docLines.length, startIdx + windowRadius)
```
with:
```js
    // Constrain the search if startLine is given. Always the live text
    // (`docText`), never `doc.lines`: that is the stored copy, which lags
    // behind unsaved typing, while the match offset is applied to the live
    // text. `from`/`until` come from lineArg above, which accepts numbers sent
    // as strings.
    if (Number.isInteger(from) && from >= 1 && doc) {
      const docLines = docText.split('\n')
      const startIdx = from - 1
      const anchorLineCount = targetAnchor.split('\n').length
      const windowRadius = Math.max(2, anchorLineCount + 1)
      const hasEnd = Number.isInteger(until) && until >= from
      const localEndIdx = hasEnd ? until : Math.min(docLines.length, startIdx + windowRadius)
```
and, a few lines below, replace exactly:
```js
        const endIdx = typeof args.endLine === 'number' && args.endLine >= args.startLine ? args.endLine : docLines.length
```
with:
```js
        const endIdx = hasEnd ? until : docLines.length
```
TRAP: `from` and `until` are declared earlier in `_planEdit` (`const from = lineArg(args.startLine)`, `const until = lineArg(args.endLine)`, around line 777). Do not declare them again.

- [x] **Step 4: Run to verify they pass**

Same command as Step 2. Expected: all pass.

---

### Task 6: An edit moves to another file only on an exact match

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (`_planEdit`, lines 871-891)
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`

- [x] **Step 1: Write the failing tests**

In `describe('edit planning')`, add:
```js
    it('does not move an edit to another file on a whitespace-only match', async function () {
      const res = await tools.checkEdit({ path: 'main.tex', oldText: 'no   match  here', newText: 'x' }, ctx)

      expect(res.status).to.equal('noMatch')
    })

    it('moves an edit to the file that contains the exact anchor', async function () {
      const res = await tools.checkEdit({ path: 'main.tex', oldText: 'no match here', newText: 'x' }, ctx)

      expect(res.status).to.equal('ok')
      expect(res.path).to.equal('chapters/intro.tex')
    })
```
(`doc-2` = `chapters/intro.tex` and `doc-bib` both contain `no match here`; `getAllDocs` lists `doc-2` first.)

- [x] **Step 2: Run to verify the first test fails**

Same command as Task 5 Step 2. Expected: `'does not move an edit … whitespace-only match'` fails (today it returns `ok` via the whitespace-agnostic matcher). The exact-match test already passes.

- [x] **Step 3: Implement**

Replace exactly:
```js
    // If not found in target file, search other project documents
    if (!targetMatch) {
      const allDocs = await this._getDocsList(projectId)
      for (const other of allDocs) {
        if (doc && String(other._id) === String(doc._id)) continue
        let otherText = (other.lines || []).join('\n')
        try {
          const fetched = await this.docUpdater.getDocument(projectId, other._id, -1)
          if (fetched?.lines) otherText = fetched.lines.join('\n')
        } catch {}

        const candidateMatch = locateAnchorInText(otherText, targetAnchor)
        if (candidateMatch) {
          resolvedDoc = other
          resolvedDocText = otherText
          targetMatch = candidateMatch
          searchLineOffset = 0
          break
        }
      }
    }
```
with:
```js
    // Not in the named file: look in the other documents. Only an exact (or
    // line-number-cleaned) match may move the edit to another file; a fuzzy
    // match in a file the model never named is a guess. Candidates come from
    // the snapshot (one flush and one bulk read), and the chosen file is
    // confirmed against its live text before anything is planned on it.
    if (!targetMatch) {
      const isExact = match => match && (match.type === 'exact' || match.type === 'cleaned')
      const snapshot = await this._getSnapshot(projectId)
      for (const other of snapshot.docs) {
        if (doc && String(other._id) === String(doc._id)) continue
        if (!isExact(locateAnchorInText((other.lines || []).join('\n'), targetAnchor))) continue

        let liveText = (other.lines || []).join('\n')
        try {
          const fetched = await this.docUpdater.getDocument(projectId, other._id, -1)
          if (fetched?.lines) liveText = fetched.lines.join('\n')
        } catch {}
        const liveMatch = locateAnchorInText(liveText, targetAnchor)
        if (!isExact(liveMatch)) continue

        resolvedDoc = other
        resolvedDocText = liveText
        targetMatch = liveMatch
        searchLineOffset = 0
        break
      }
    }
```
TRAP: `snapshot.docs` entries have `_id`, `path` and `lines` (see `_getSnapshot`, `:603-657`), the same shape as `_getDocsList` entries.

- [x] **Step 4: Run to verify they pass**

Same command as Task 5 Step 2. Expected: all pass, including `'checkEdit reports noMatch…'`, `'checkEdit reports ambiguous…'` and `'edit_file returns a noMatch status…'`.

---

### Task 7: Paths resolve on whole segments only

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (`_resolveDoc` lines 721-725; `read_file` not-found branch lines 1025-1032)
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`

- [x] **Step 1: Write the failing tests**

In `describe('read_file limits')` (it has `ctx`), add:
```js
    it('does not resolve a.tex to data.tex', async function () {
      mockEntityHandler.getAllDocs = sinon.stub().resolves([{ _id: 'doc-data', name: 'data.tex', path: 'data.tex' }])

      const res = await tools.execute('read_file', { path: 'a.tex' }, ctx)

      expect(res.error).to.equal('File not found: a.tex')
    })

    it('resolves a bare file name when exactly one document has it', async function () {
      mockEntityHandler.getAllDocs = sinon.stub().resolves([{ _id: 'doc-2', name: 'intro.tex', path: 'chapters/intro.tex' }])

      const res = await tools.execute('read_file', { path: 'intro.tex' }, ctx)

      expect(res.error).to.equal(undefined)
      expect(res.totalLines).to.equal(2)
    })

    it('names the candidates when a bare file name is ambiguous', async function () {
      mockEntityHandler.getAllDocs = sinon.stub().resolves([
        { _id: 'doc-a', name: 'intro.tex', path: 'a/intro.tex' },
        { _id: 'doc-b', name: 'intro.tex', path: 'b/intro.tex' },
      ])

      const res = await tools.execute('read_file', { path: 'intro.tex' }, ctx)

      expect(res.error).to.equal('File not found: intro.tex. Did you mean a/intro.tex or b/intro.tex?')
    })
```
(`getDocIdByPath` returns `null` for these paths, so `_resolveDoc` falls back to scanning `getAllDocs`. `getDocument` for any id other than `doc-1` returns two lines.)

- [x] **Step 2: Run to verify they fail**

Same command as Task 5 Step 2. Expected: the first and third tests fail.

- [x] **Step 3: Implement `_resolveDoc`**

Replace exactly:
```js
    const docs = await this._getDocsList(projectId)
    const exact = docs.find(d => d.path === normalized || d.name === normalized)
    if (exact) return exact
    const suffix = docs.find(d => d.path.endsWith(normalized) || normalized.endsWith(d.name))
    return suffix || null
```
with:
```js
    const docs = await this._getDocsList(projectId)
    const exact = docs.find(d => d.path === normalized)
    if (exact) return exact
    // A partial path matches whole path segments only ("intro.tex" matches
    // "chapters/intro.tex", never "myintro.tex"), and only when exactly one
    // document fits: taking the first of several reads or edits the wrong file.
    const bySegments = docs.filter(d => d.path.endsWith(`/${normalized}`))
    return bySegments.length === 1 ? bySegments[0] : null
```

- [x] **Step 4: Name the candidates in `read_file`**

Replace exactly:
```js
          if (files.some(file => file.path === wanted)) {
            return { error: `${wanted} is a binary file and cannot be read as text.` }
          }
          return { error: `File not found: ${args.path}` }
```
with:
```js
          if (files.some(file => file.path === wanted)) {
            return { error: `${wanted} is a binary file and cannot be read as text.` }
          }
          const baseName = wanted.split('/').pop()
          const candidates = (await this._getDocsList(projectId).catch(() => []))
            .map(d => d.path)
            .filter(path => path !== wanted && path.split('/').pop() === baseName)
          if (candidates.length > 1) {
            return { error: `File not found: ${args.path}. Did you mean ${candidates.join(' or ')}?` }
          }
          return { error: `File not found: ${args.path}` }
```

- [x] **Step 5: Run to verify they pass**

Same command as Task 5 Step 2. Expected: all pass, including `'handles getAllDocs returning an object dictionary…'` and the snapshot tests.

---

### Task 8: The tool refuses to append after `\end{document}`; the prompt workaround goes

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (new export; append branch line 819; noMatch message line 927)
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts` (append branch line 92; noMatch message line 181)
- Modify: `modules/ai-assist/app/src/AiAssistSystemPrompt.mjs` and `modules/ai-assist/frontend/js/features/ai-assist/agent/context/system-prompt.ts` (lines 74-79, identical in both)
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`, `modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts`

- [x] **Step 1: Write the failing server tests**

At the top of `AiAssistTools.test.mjs`, line 3 is `import { AiAssistTools } from '../../../app/src/AiAssistTools.mjs'`. Change it to `import { AiAssistTools, endDocumentLine } from '../../../app/src/AiAssistTools.mjs'`. Then in `describe('edit planning')` add:
```js
    it('endDocumentLine finds the last uncommented \\end{document}', function () {
      expect(endDocumentLine('a\n\\end{document}\n')).to.equal(2)
      expect(endDocumentLine('a\n% \\end{document}\n')).to.equal(null)
      expect(endDocumentLine('\\end{document} % done')).to.equal(1)
      expect(endDocumentLine('no end here')).to.equal(null)
    })

    it('refuses to append after \\end{document}', async function () {
      mockDocUpdater.getDocument = sinon.stub().resolves({ lines: ['\\begin{document}', 'x', '\\end{document}'] })

      const res = await tools.checkEdit({ path: 'main.tex', oldText: '', newText: 'y' }, ctx)

      expect(res.status).to.equal('error')
      expect(res.error).to.include('line 3')
    })

    it('still appends to a file without \\end{document}', async function () {
      const res = await tools.checkEdit({ path: 'main.tex', oldText: '', newText: 'line 4' }, ctx)

      expect(res.status).to.equal('ok')
    })
```

- [x] **Step 2: Write the failing browser tests**

In `edit-tool.test.ts`, add below the existing imports:
```ts
import { endDocumentLine } from '../../../../frontend/js/features/ai-assist/agent/tools/edit-file'
```
and inside `describe('edit_file', …)`, after `'appends to the file when oldText is empty'`, add:
```ts
  it('refuses to append after \\end{document} without proposing an edit', async function () {
    const { handle, calls } = createFakeHandle({
      docs: { 'paper.tex': '\\begin{document}\nHi\n\\end{document}\n' },
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'paper.tex', oldText: '', newText: 'more' },
      handle
    )

    expect(result.error).to.include('line 3')
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('endDocumentLine ignores a commented-out \\end{document}', function () {
    expect(endDocumentLine('x\n% \\end{document}')).to.equal(null)
    expect(endDocumentLine('x\n\\end{document}\n')).to.equal(2)
  })
```

- [x] **Step 3: Run to verify they fail**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs 2>&1 | grep -E "Tests |×" | head
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --reporter dot modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts 2>&1 | grep -E "passing|failing|Error" | head
```

- [x] **Step 4: Server helper and guard**

(a) In `AiAssistTools.mjs`, directly after `describeAppliedEdit` (Task 4), add:
```js

/**
 * The 1-based line of the last uncommented `\end{document}`, or null. Text
 * appended to the end of such a file lands after it, where LaTeX never reads it.
 */
export function endDocumentLine(docText) {
  const lines = String(docText || '').split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const code = lines[index].replace(/(^|[^\\])%.*$/, '$1')
    if (code.includes('\\end{document}')) return index + 1
  }
  return null
}
```

(b) Replace exactly:
```js
    // Append mode: when oldText is explicitly empty string ""
    if (args.oldText === '' && doc) {
```
with:
```js
    // Append mode: when oldText is explicitly empty string ""
    if (args.oldText === '' && doc) {
      const endLine = endDocumentLine(docText)
      if (endLine) {
        return {
          result: {
            status: 'error',
            error: `Appending to ${doc.path} would put the text after \\end{document} on line ${endLine}, where LaTeX ignores it. Insert it where it belongs instead: give an oldText anchor from the passage it follows, or startLine and endLine for the lines to replace.`,
          },
        }
      }
```
TRAP: an empty document never reaches this branch: the whole-file branch above it handles `isDocEmpty`. Line-range edits (`startLine`+`endLine` with `oldText: ''`) return earlier too. Only a true append is guarded.

(c) In the noMatch error, replace exactly:
```js
 To replace or delete whole lines, pass startLine and endLine and omit oldText. Do not call edit_file with oldText: "" and no line range unless you want to append to the end of the file.`,
```
with:
```js
 To replace or delete whole lines, pass startLine and endLine and omit oldText.`,
```

- [x] **Step 5: Browser helper and guard**

In `frontend/js/features/ai-assist/agent/tools/edit-file.ts`:

(a) Replace exactly:
```ts
export const editFileTool: AgentTool = {
```
with:
```ts
/**
 * The 1-based line of the last uncommented `\end{document}`, or null. Text
 * appended to the end of such a file lands after it, where LaTeX never reads
 * it. Mirrors `endDocumentLine` in AiAssistTools.mjs.
 */
export function endDocumentLine(docText: string): number | null {
  const lines = String(docText || '').split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const code = lines[index].replace(/(^|[^\\])%.*$/, '$1')
    if (code.includes('\\end{document}')) return index + 1
  }
  return null
}

export const editFileTool: AgentTool = {
```

(b) Replace exactly:
```ts
    const isAppend = oldText.length === 0
    if (isAppend) {
      const outcome = await handle.proposeEdit({ path, oldText: '', newText: sanitizedNewText })
```
with:
```ts
    const isAppend = oldText.length === 0
    if (isAppend) {
      const current = await handle.readFile(path)
      const endLine = endDocumentLine(current.lines.join('\n'))
      if (endLine) {
        return {
          error: `Appending to ${path} would put the text after \\end{document} on line ${endLine}, where LaTeX ignores it. Insert it where it belongs instead: give an oldText anchor from the passage it follows.`,
        }
      }
      const outcome = await handle.proposeEdit({ path, oldText: '', newText: sanitizedNewText })
```

(c) In the `noMatch` message, delete exactly this text (keep everything around it, including the closing backtick and comma):
```
 Do not call edit_file with oldText: "" unless you want to append to the end of the file.
```

- [x] **Step 6: Delete the prompt workaround (both prompt files, identically)**

In **both** `app/src/AiAssistSystemPrompt.mjs` and `frontend/js/features/ai-assist/agent/context/system-prompt.ts`, delete exactly these six lines (lines 74-79):
```js
  'Always edit existing text in place. Never pass `oldText: ""` to append content',
  'to the end of the file unless the user explicitly requested to append to the end',
  'of the document. In LaTeX documents, appending to the end places text after',
  '\\end{document}, which breaks compilation. To edit, fix, or add text inside a file,',
  'use `read_file` or `search_text` first to find the exact existing lines, and supply',
  'those lines in `oldText`.',
```
Keep the line before them (`'in the file. Include surrounding lines if a short anchor would be ambiguous.',`) and the blank `''` line after.

- [x] **Step 7: Run to verify they pass, and that both prompts are still identical**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs modules/ai-assist/test/unit/src/AiAssistSystemPrompt.test.mjs 2>&1 | grep -E "Tests |×" | head
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --reporter dot modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts modules/ai-assist/test/frontend/js/context/system-prompt.test.ts modules/ai-assist/test/frontend/js/agent/system-prompt.test.ts 2>&1 | grep -E "passing|failing|Error" | head
```
Expected: 0 failures. `AiAssistSystemPrompt.test.mjs` `'is identical to the browser agent prompt'` must pass.

---

### Task 9: A leaner tool list, and search context in order

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (`search_text` spec lines 1903-1906; `editorTheme` line 2021; `list_available_settings` description line 2135)
- Modify: `AiAssistSystemPrompt.mjs` and `system-prompt.ts` (lines 63-68, identically)
- Modify: `modules/ai-assist/app/src/AiAssistToolRender.mjs` (`search_text` renderer)
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/search-text.ts` (`render`)
- Test: `AiAssistTools.test.mjs`, `AiAssistToolRender.test.mjs`, `test/frontend/js/agent/read-tools.test.ts`

- [x] **Step 1: Write the failing tests**

(a) `AiAssistTools.test.mjs`, after `'returns all 15 tool specifications in getToolSpecs'`:
```js
  it('keeps the tool schemas lean', function () {
    const specs = tools.getToolSpecs()
    const search = specs.find(s => s.name === 'search_text')
    expect(search.parameters.properties).to.not.have.property('path')
    const appearance = specs.find(s => s.name === 'configure_appearance_settings')
    expect(appearance.parameters.properties.editorTheme.description.length).to.be.lessThan(120)
    const available = specs.find(s => s.name === 'list_available_settings')
    expect(available.description.length).to.be.lessThan(200)
  })

  it('search_text still honours a path argument', async function () {
    const res = await tools.execute(
      'search_text',
      { query: 'no match', path: 'chapters/*.tex' },
      { projectId: 'p1', userId: '012345678901234567890123' }
    )
    expect(res.hits.map(hit => hit.path)).to.deep.equal(['chapters/intro.tex'])
  })
```

(b) `AiAssistToolRender.test.mjs`:
```js
  it('renders search context lines in file order', function () {
    expect(renderToolResult('search_text', {
      hits: [{ path: 'main.tex', line: 5, text: 'hit', before: ['b1', 'b2'], after: ['a1'] }],
      total: 1,
      truncated: false,
    })).to.equal('Found 1 hit(s):\n  3: b1\n  4: b2\nmain.tex:5: hit\n  6: a1')
  })
```

(c) `read-tools.test.ts`, inside the top-level `describe`:
```ts
  it('search_text renders context lines in file order', function () {
    expect(
      searchTextTool.render!({
        hits: [{ path: 'main.tex', line: 5, text: 'hit', before: ['b1', 'b2'], after: ['a1'] }],
        total: 1,
        truncated: false,
      })
    ).to.equal('Found 1 hit(s):\n  3: b1\n  4: b2\nmain.tex:5: hit\n  6: a1')
  })
```
(`searchTextTool` is already imported at the top of the file.)

- [x] **Step 2: Run to verify they fail**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs modules/ai-assist/test/unit/src/AiAssistToolRender.test.mjs 2>&1 | grep -E "Tests |×" | head
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js --reporter dot modules/ai-assist/test/frontend/js/agent/read-tools.test.ts 2>&1 | grep -E "passing|failing" 
```
Expected: `'keeps the tool schemas lean'` and both render-order tests fail. `'search_text still honours a path argument'` already passes and must keep passing.

- [x] **Step 3: Trim the server specs**

(a) Delete exactly (inside the `search_text` spec):
```js
            path: {
              type: 'string',
              description: 'Specific file path or glob pattern to search in (alias for glob)',
            },
```
Do **not** change the `search_text` case in `execute`: it still reads `args.path`.

(b) Replace the whole `editorTheme` description string (line 2021, it starts `'Editor syntax theme. Overleaf supports: cobalt, dracula, …`) so the property reads:
```js
            editorTheme: {
              type: 'string',
              description:
                'Editor syntax theme name, e.g. "monokai". list_available_settings lists every theme.',
            },
```

(c) Replace exactly:
```js
          'List all allowed and available options for project and editor settings: compilers, TeX Live versions, spellcheck languages, overall themes, all 40+ editor syntax themes, code fonts (fontFamilies: monaco, lucida, opendyslexicmono), line heights, font sizes, and PDF viewers.',
```
with:
```js
          'List the allowed values for every setting: compilers, TeX Live versions, spell-check languages, themes, fonts, line heights, font sizes and PDF viewers.',
```

- [x] **Step 4: Shorten the prompt's settings rung (both prompt files, identically)**

In **both** `AiAssistSystemPrompt.mjs` and `system-prompt.ts`, replace exactly (lines 63-68):
```js
  '7. Settings — `get_project_settings` for reading project, compiler, appearance,',
  '   and editor configuration; `configure_compiler_settings` for compiler engine,',
  '   TeX Live version, root document, draft mode, and stop on first error; `configure_appearance_settings`',
  '   for overall theme, editor syntax theme (Overleaf supports 40+ themes: dracula, monokai, nord_dark, solarized, etc.), code fonts (monaco, lucida, opendyslexicmono), font size, line height, and PDF dark mode; `configure_editor_settings` for',
  '   keybinding mode, auto-complete, bracket pairing, and editor preferences; and',
  '   `list_available_settings` to list all available choices, code fonts, and themes.',
```
with:
```js
  '7. Settings — `get_project_settings` reads them; `configure_compiler_settings`,',
  '   `configure_appearance_settings` and `configure_editor_settings` change them;',
  '   `list_available_settings` lists the allowed values.',
```
TRAP: `test/frontend/js/agent/system-prompt.test.ts` requires the prompt to name **every** tool in the registry. All five settings tool names are still present in the replacement. Do not drop any.

- [x] **Step 5: Render search context in order (server and browser)**

(a) In `AiAssistToolRender.mjs`, replace exactly:
```js
        lines.push(`${hit.path}:${hit.line}: ${hit.text}`)
        if (Array.isArray(hit.before) && hit.before.length > 0) {
          lines.push(...hit.before.map((l, i) => `  ${hit.line - hit.before.length + i}: ${l}`))
        }
```
with:
```js
        if (Array.isArray(hit.before) && hit.before.length > 0) {
          lines.push(...hit.before.map((l, i) => `  ${hit.line - hit.before.length + i}: ${l}`))
        }
        lines.push(`${hit.path}:${hit.line}: ${hit.text}`)
```

(b) In `search-text.ts` `render`, replace exactly:
```ts
        lines.push(`${hit.path}:${hit.line}: ${hit.text}`)
        if (Array.isArray(hit.before) && hit.before.length > 0) {
          lines.push(...hit.before.map((l: string, i: number) => `  ${hit.line - hit.before.length + i}: ${l}`))
        }
```
with:
```ts
        if (Array.isArray(hit.before) && hit.before.length > 0) {
          lines.push(...hit.before.map((l: string, i: number) => `  ${hit.line - hit.before.length + i}: ${l}`))
        }
        lines.push(`${hit.path}:${hit.line}: ${hit.text}`)
```

- [x] **Step 6: Run to verify they pass**

Same commands as Step 2, plus the prompt tests from Task 8 Step 7. Expected: 0 failures.

---

### Task 10: Final verification

- [x] **Step 1: Full backend module suite**
```bash
XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src 2>&1 | grep -E "Test Files|Tests "
```
Expected: 0 failed. Passed = baseline + the tests this plan added.

- [x] **Step 2: Full frontend module suite** (command in Global Constraints). Expected: 0 failing.

- [x] **Step 3: Type-check the touched browser files**
```bash
timeout 600 ../../node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -E "ai-assist/agent/(tools/(compile-result|read-file|edit-file|search-text)|use-project-handle|context/system-prompt)"
```
Expected: no output. Errors in other files that existed before are not yours.

- [x] **Step 4: Do not redeploy yet** unless WS-C is already finished; WS-C's last task redeploys once for all three plans. If you are running WS-B alone and the user wants to look at it, use WS-C's final redeploy step.

---

## Out of scope (checked, do not do)

- **Merging the five settings tools into one.** The tool-call UI and `live-settings-updater.ts` key on their names. Descriptions shrink instead.
- **Removing `path` from the browser `search_text` schema.** Pinned by `read-tools.test.ts:247-251`.
- **Deleting `resolveEditTarget`** (unused). Separate cleanup.
- **Porting `describeAppliedEdit` to the browser `edit_file`.** The browser applies edits through the editor bridge, which reports its own outcome. Separate change.
- **Sharing compile results across web instances** (e.g. in Redis). `get_compile_result` now says plainly when this instance has nothing; the model calls `compile_project`.
- **Changing `MAX_READ_LINES` (1000) for explicit ranges.**
