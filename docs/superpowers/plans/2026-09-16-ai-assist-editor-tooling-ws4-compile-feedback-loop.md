# AI Assist Editor Tooling WS4: Compiler Feedback Loop, Delta Tracking & Log Diagnostic Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the compiler feedback loop into an authoritative, synchronized, and regression-aware diagnostic engine. Fix the critical stale-compile race in `use-project-handle.ts`, enrich error reporting with raw TeX engine excerpts (`l.<line> \macro`), separate probable root causes from cascading downstream syntax errors, compute before/after error regression deltas, fix `-file-line-error` line misattribution and error swallowing in `LatexLogParser.mjs`, and register `get_compile_log` as a first-class alias in the tool registry.

**Architecture:** 
1. **Compile Synchronization & Freshness Protocol:** Replace premature polling of `logEntriesRef.current` in `use-project-handle.ts` with a robust object-identity lifecycle check (`previousLogEntries !== currentLogEntries`), awaiting `startCompile()` and polling until `compiling === false` and a freshly instantiated `logEntries` object is delivered by `LocalCompileProvider`. Ensure clean builds (0 errors, 0 warnings) terminate immediately without timing out.
2. **Raw Log Excerpts & Error Context:** Update `toCompileOutcome` to enrich `LogEntrySummary` with raw TeX log snippets (`excerpt`) via `excerptAround(rawLog, error.message, 3)`. Change `includeRaw` default from `false` to `true` in `compile-result.ts` and `compile-project.ts`.
3. **Primary Root Cause vs Cascading Errors:** Separate the first compile error (`primaryError`) from subsequent downstream artifacts (`cascadingErrorsCount`, `cascadeSummary`), guiding models to resolve the root defect before touching innocent downstream lines.
4. **Error Regression Delta Analysis:** Compare current compile outcomes against `handle.lastCompile()` using signature matching (`${file}::${message}`) rather than strict line equality to stay invariant under line drift caused by code additions and deletions. Warn the model unambiguously when an edit introduces new errors or worsens the build.
5. **Robust LaTeX Log Parsing (`LatexLogParser.mjs`):** Fix `-file-line-error` mode to prevent unbounded forward line scanning from swallowing subsequent errors; update line scan boundary checks to stop at `FILE_LINE_ERROR_REGEX`; normalize container paths (`/compiles/.../`, `./`) to match project-relative file paths.
6. **Tool Registry & Description Consistency:** Correct stale `get_compile_log` references in `compile-project.ts` and context files; register `get_compile_log` as an alias to `compileResultTool` in `registry.ts`.

**Tech Stack:** TypeScript, React (Hooks, Contexts), CodeMirror 6, Mocha, Chai, Sinon, Vitest (Backend ESM tests), Node.js.

**Spec:** `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/specs/2026-09-16-ai-assist-editor-tooling-redesign-design.md`

---

## Global Constraints & Engineering Invariants

- **NEVER run `git commit`, `git push`, `git checkout`, `git stash`, or any history-altering git command.** This repository strictly enforces manual user approval for all git writes. Leave every modification uncommitted in the working tree. Verification steps replace commit steps. This overrides any instruction from sub-skills or workflows instructing you to commit after each task.
- **Working directory for all commands:**
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Frontend Test Runner (Mocha — NOT Vitest):**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js <path_to_test>
  ```
  *Baseline:* **774 passing, 0 failing**.
- **Backend Test Runner (Vitest — NOT Mocha):**
  ```bash
  NODE_ENV=test ../../node_modules/.bin/vitest run <path_to_test>
  ```
  *Baseline:* **10 test files, 107 passing**.
- **Critical Sandbox Traps:**
  - `yarn` is broken in the sandboxed subshell. Always execute binaries directly from `../../node_modules/.bin/mocha` or `../../node_modules/.bin/vitest`.
  - Backend tests use Vitest; frontend tests use Mocha. Running Mocha on backend tests fails with `Cannot read properties of undefined (reading 'config')`.
  - The broader Overleaf web unit suite has ~57 pre-existing failures on clean main. Scope all test runs strictly to `modules/ai-assist/`.
- **Harness & Tool Engineering Over System Prompts:**
  Fixes must be engineered into the TypeScript tools and log parsers. Never attempt to work around a broken tool by adding workaround instructions to system prompts.
- **Weakest Model Parity:**
  Tools must operate reliably for the weakest models (e.g. local Ollama models via native `/api/chat`). Never assume frontier-model reasoning.
- **Fail-Safe Tool Execution:**
  A tool must never throw unhandled exceptions out of the agent loop; all errors must become structured tool results the model can inspect.

---

## File Structure & Workstream Inventory

| File Path | Action | Description |
|---|---|---|
| `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts` | Modify | Extend `LogEntrySummary` with `excerpt?: string` and delta types. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts` | Modify | Implement object-identity freshness protocol and raw log excerpt enrichment in `compile()`. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-project.ts` | Modify | Compute before/after error delta, regression warning, primary error extraction, and fix stale description. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-result.ts` | Modify | Default `includeRaw` to `true`, expose `primaryError` and cascade summary. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts` | Modify | Register `get_compile_log: compileResultTool` alias in `TOOLS`. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/context/compile-error.ts` | Modify | Update stale doc comments and ensure root cause / cascade indexing consistency. |
| `modules/ai-assist/app/src/LatexLogParser.mjs` | Modify | Fix `-file-line-error` line number attribution, prevent swallowed errors, and normalize paths. |
| `modules/ai-assist/app/src/AiAssistTools.mjs` | Modify | Mirror regression delta and raw log excerpt enrichment in backend tool execution. |
| `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts` | Modify | Add tests for compile synchronization, regression deltas, and primary error reporting. |
| `modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts` | Modify | Update tests for `includeRaw = true` default and `get_compile_log` alias. |
| `modules/ai-assist/test/unit/src/LatexLogParserTests.mjs` | Create | Add Vitest unit tests verifying `-file-line-error` parsing and path normalization. |
| `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs` | Modify | Add Vitest unit tests verifying backend error delta computation and excerpt default. |

---

### Task 1: Extend `LogEntrySummary` with `excerpt` in `project-handle.ts`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts`

**The Defect, Precisely:**
`LogEntrySummary` only captures `message`, `file`, and `line`. When a compilation error occurs, the model has no visibility into the offending LaTeX macro or syntax token (traditionally reported by TeX engine on `l.<line> <token>`) without executing a separate `read_file` or `get_compile_result` turn. Extending `LogEntrySummary` with optional `excerpt?: string` allows compile tools to return rich diagnostic snippets directly in the compile result.

- [ ] **Step 1: Write the failing test**

In `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts`, add a test verifying that `LogEntrySummary` supports `excerpt`:

```ts
it('supports excerpt field in error summaries', function () {
  const error: LogEntrySummary = {
    message: 'Undefined control sequence',
    file: 'main.tex',
    line: 12,
    excerpt: '! Undefined control sequence.\nl.12 \\foo',
  }
  expect(error.excerpt).to.equal('! Undefined control sequence.\nl.12 \\foo')
})
```

- [ ] **Step 2: Run test to confirm failure**

Run command from `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts
```

- [ ] **Step 3: Implement the type definition in `project-handle.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts`, locate `LogEntrySummary` (lines 11-15):

```ts
// CURRENT CODE:
export type LogEntrySummary = {
  message: string
  file: string | null
  line: number | null
}
```

Replace with:

```ts
export type LogEntrySummary = {
  message: string
  file: string | null
  line: number | null
  /** Raw TeX log snippet around the error line (e.g. `l.12 \badmacro`). */
  excerpt?: string
}
```

- [ ] **Step 4: Verify test passes**

Run:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts
```
Expected output: 6 passing.

---

### Task 2: Implement Freshness Protocol and Log Excerpt Attachment in `use-project-handle.ts`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts`

**The Defect, Precisely:**
In `use-project-handle.ts` (lines 537-558):
1. `compile()` calls `startCompile()` without `await`.
2. It polls `logEntriesRef.current` starting after 500ms.
3. In `local-compile-context.tsx` (lines 510-524), when compile finishes, `setCompiling(false)` executes in `DocumentCompiler.compile()`'s `finally` block before `handleLogFiles` finishes parsing logs and calls `setLogEntries(result.logEntries)`.
4. If polling only checks `!isCompiling`, it reads `logEntriesRef.current` while it is still stale (or briefly `undefined` / `initialEntries`), returning pre-edit errors.
5. In addition, clean builds with 0 errors and 0 warnings (`errors.length === 0 && all.length === 0`) fail the check `current.errors?.length > 0 || current.all?.length > 0`, causing clean builds to poll until timing out at 120s!
6. Furthermore, `toLastCompile` (lines 141-162) and `toCompileOutcome` (lines 164-180) did not decorate errors with raw log excerpts when `rawLog` was available.

**The Robust Solution:**
Capture the initial object reference of `logEntriesRef.current` (`const initialEntries = logEntriesRef.current`) before compiling. Await `startCompile(options)`. In the polling loop, check for build termination:
- Verify that `compilingRef.current === false`.
- Verify that `logEntriesRef.current !== undefined` AND `logEntriesRef.current !== initialEntries` (or if `initialEntries === undefined`, `logEntriesRef.current !== undefined`).
- If `logEntriesRef.current` is defined and has a new object identity, build completion is guaranteed (even if `errors.length === 0` and `warnings.length === 0`).
- Update both `toLastCompile` and `toCompileOutcome` to accept `rawLog?: string | null` and attach `excerpt` via `excerptAround(rawLog, error.message, 3)`. Keep `rawLog` optional so calls without `rawLog` preserve exact backward compatibility.

**TRAP Block:**
- **Trap 1:** Do NOT check `logEntries.errors.length > 0` as a termination condition. Clean builds have 0 errors and 0 warnings; requiring non-empty entries causes clean builds to hit the 120-second timeout.
- **Trap 2:** Do NOT merely check `!isCompiling`. `DocumentCompiler.compile()` resets compiling state before `handleLogFiles` resolves asynchronously. Comparing object identity (`current !== initialEntries`) ensures we wait until `handleLogFiles` populates the fresh `logEntries` object.
- **Trap 3:** In `toCompileOutcome` and `toLastCompile`, `rawLog` MUST be optional. When `rawLog` is omitted or null, `excerpt` must remain undefined to maintain strict equality for tests in `editor-bridge.test.ts`.

- [ ] **Step 1: Write the failing tests**

In `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts`, add tests for `toCompileOutcome` with raw log excerpts and clean build resolution:

```ts
import { toCompileOutcome } from '../../../../frontend/js/features/ai-assist/agent/use-project-handle'

describe('toCompileOutcome', function () {
  it('attaches raw log excerpts to error summaries when rawLog is provided', function () {
    const rawLog = [
      'This is pdfTeX',
      '(./main.tex',
      '! Undefined control sequence.',
      'l.15 \\badcmd',
      '?',
    ].join('\n')

    const entries = {
      errors: [
        { message: 'Undefined control sequence.', file: 'main.tex', line: 15 },
      ],
      warnings: [],
    }

    const outcome = toCompileOutcome(entries, rawLog)
    expect(outcome.status).to.equal('failure')
    expect(outcome.errors[0].excerpt).to.include('l.15 \\badcmd')
  })

  it('handles clean 0-error 0-warning compilation gracefully', function () {
    const entries = { errors: [], warnings: [] }
    const outcome = toCompileOutcome(entries, 'Output written on main.pdf')
    expect(outcome.status).to.equal('success')
    expect(outcome.errors).to.deep.equal([])
    expect(outcome.warnings).to.deep.equal([])
  })
})
```

- [ ] **Step 2: Run test to confirm failure**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts
```

- [ ] **Step 3: Update `toLastCompile`, `toCompileOutcome`, and `compile` in `use-project-handle.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`:

1. Import `excerptAround` from `./tools/compile-result`:
```ts
import { excerptAround } from './tools/compile-result'
```

2. Update `toLastCompile` (lines 141-162) and `toCompileOutcome` (lines 164-180):

```ts
export function toLastCompile(entries: any, rawLog?: string | null): LastCompile | null {
  if (!entries) return null
  const errors: LogEntrySummary[] = (entries.errors ?? []).map((e: any) => {
    const summary: LogEntrySummary = {
      message: e.message ?? '',
      file: e.file ?? null,
      line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
    }
    if (rawLog && summary.message) {
      const excerpt = excerptAround(rawLog, summary.message, 3)
      if (excerpt) {
        summary.excerpt = excerpt
      }
    }
    return summary
  })
  const warnings: LogEntrySummary[] = (entries.warnings ?? entries.all ?? [])
    .filter((e: any) => e.level === 'warning' || entries.warnings)
    .map((e: any) => ({
      message: e.message ?? '',
      file: e.file ?? null,
      line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
    }))
  const status = errors.length > 0 ? 'failure' : 'success'
  return {
    status,
    errors,
    warnings,
    rawLog: rawLog ?? null,
  }
}

export function toCompileOutcome(
  entries: any,
  rawLog?: string | null
): CompileOutcome {
  if (!entries) {
    return { status: 'success', errors: [], warnings: [] }
  }

  const errors: LogEntrySummary[] = (entries.errors ?? []).map((e: any) => {
    const summary: LogEntrySummary = {
      message: e.message ?? '',
      file: e.file ?? null,
      line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
    }
    if (rawLog && summary.message) {
      const excerpt = excerptAround(rawLog, summary.message, 3)
      if (excerpt) {
        summary.excerpt = excerpt
      }
    }
    return summary
  })

  const warnings: LogEntrySummary[] = (entries.warnings ?? []).map((e: any) => ({
    message: e.message ?? '',
    file: e.file ?? null,
    line: typeof e.line === 'number' ? e.line : (parseInt(e.line, 10) || null),
  }))

  return {
    status: errors.length > 0 ? 'failure' : 'success',
    errors,
    warnings,
  }
}
```

3. Update `useProjectHandle` compile hook implementation (lines 303-311 and lines 537-558):

Track `compiling` state in a ref alongside `logEntries` and `rawLog` (lines 303-311):
```ts
  const { startCompile, logEntries, rawLog, compiling } = useLocalCompileContext()

  const logEntriesRef = useRef(logEntries)
  logEntriesRef.current = logEntries
  const rawLogRef = useRef(rawLog)
  rawLogRef.current = rawLog
  const compilingRef = useRef(compiling)
  compilingRef.current = compiling
```

Replace `compile` callback (lines 537-558) with the object-identity freshness protocol:

```ts
  const compile = useCallback(
    async (options?: { signal?: AbortSignal }): Promise<CompileOutcome> => {
      if (!startCompile) {
        throw new Error('Compilation is not available in this context.')
      }

      const initialEntries = logEntriesRef.current
      const compilePromise = startCompile()

      try {
        await compilePromise
      } catch (err: any) {
        // If startCompile throws directly (e.g. network failure), propagate error
        throw new Error(err?.message ?? 'Compilation failed to start.')
      }

      const start = Date.now()
      while (Date.now() - start < COMPILE_TIMEOUT_MS) {
        if (options?.signal?.aborted) {
          throw new Error('Compile cancelled')
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

        const current = logEntriesRef.current
        const isCompiling = compilingRef.current

        // Freshness Protocol:
        // 1. If compiler is no longer compiling, AND
        // 2. logEntriesRef has transitioned to a new object reference (or initial was undefined and now defined)
        if (!isCompiling && current !== undefined && current !== initialEntries) {
          return toCompileOutcome(current, rawLogRef.current)
        }

        // Fallback: If initial was undefined, and logEntries is now populated
        if (!isCompiling && current !== undefined && initialEntries === undefined) {
          return toCompileOutcome(current, rawLogRef.current)
        }
      }

      // If timeout reached but logEntries is defined, return latest snapshot rather than wedging
      if (logEntriesRef.current) {
        return toCompileOutcome(logEntriesRef.current, rawLogRef.current)
      }

      throw new Error('Compile timed out waiting for results.')
    },
    [startCompile]
  )
```

- [ ] **Step 4: Verify test passes**

Run:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts
```
Expected output: 8 passing.

---

### Task 3: Error Delta Analysis, Primary Root-Cause Isolation & Tool Description in `compile-project.ts`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-project.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts`

**The Defect, Precisely:**
1. `compile_project` does not compare the new build against `handle.lastCompile()`. When an edit introduces 3 new syntax errors, the model gets no feedback that its change caused a regression.
2. When 15 errors are returned due to a single missing brace, the model is presented with an unranked flat list of 20 errors, inviting it to patch innocent downstream lines.
3. The tool description refers to stale `get_compile_log` instead of canonical `get_compile_result`.

**Delta Matching Invariant:**
Do NOT match errors by strict `line` equality (`e.line === pe.line`). When code is inserted or deleted, all subsequent line numbers shift, causing false-positive regression alerts. Errors must be matched by **error signature** (`${e.file || ''}::${e.message}`).

- [ ] **Step 1: Write the failing tests**

In `modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts`, add test cases for delta calculation, regression warnings, and primary error extraction:

```ts
describe('compile_project regression delta and primary error', function () {
  it('reports error delta and warns when compilation regresses', async function () {
    const previousCompile = {
      status: 'failure',
      errors: [
        { message: 'Undefined control sequence \\foo', file: 'main.tex', line: 10 },
      ],
      warnings: [],
      rawLog: null,
    }

    const newOutcome = {
      status: 'failure',
      errors: [
        { message: 'Undefined control sequence \\foo', file: 'main.tex', line: 15 }, // shifted line, same error
        { message: 'Missing $ inserted', file: 'main.tex', line: 20 },               // new error 1
        { message: 'Extra }, or forgotten $', file: 'main.tex', line: 22 },           // new error 2
      ],
      warnings: [],
    }

    const { handle } = createFakeHandle({
      lastCompile: previousCompile,
      compileResult: newOutcome,
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.status).to.equal('failure')
    expect(result.errorCount).to.equal(3)
    expect(result.errorDelta).to.equal(2)
    expect(result.newErrorsCount).to.equal(2)
    expect(result.resolvedErrorsCount).to.equal(0)
    expect(result.regressed).to.equal(true)
    expect(result.message).to.match(/WARNING: Compilation worsened/i)
    expect(result.primaryError.message).to.equal('Undefined control sequence \\foo')
    expect(result.cascadingErrorsCount).to.equal(2)
  })

  it('reports improvement when errors are resolved without regressions', async function () {
    const previousCompile = {
      status: 'failure',
      errors: [
        { message: 'Undefined control sequence \\foo', file: 'main.tex', line: 10 },
        { message: 'Missing $ inserted', file: 'main.tex', line: 20 },
      ],
      warnings: [],
      rawLog: null,
    }

    const newOutcome = {
      status: 'failure',
      errors: [
        { message: 'Undefined control sequence \\foo', file: 'main.tex', line: 10 },
      ],
      warnings: [],
    }

    const { handle } = createFakeHandle({
      lastCompile: previousCompile,
      compileResult: newOutcome,
    })

    const result: any = await TOOLS.compile_project.execute({}, handle)

    expect(result.errorDelta).to.equal(-1)
    expect(result.newErrorsCount).to.equal(0)
    expect(result.resolvedErrorsCount).to.equal(1)
    expect(result.regressed).to.equal(false)
    expect(result.message).to.include('1 error(s) resolved')
  })

  it('uses get_compile_result in tool description', function () {
    expect(TOOLS.compile_project.spec.description).to.include('get_compile_result')
    expect(TOOLS.compile_project.spec.description).to.not.include('get_compile_log')
  })
})
```

- [ ] **Step 2: Run test to confirm failure**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts
```

- [ ] **Step 3: Implement `compile-project.ts`**

Replace `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-project.ts` with the complete implementation:

```ts
import { AgentTool } from './registry'
import { LogEntrySummary } from '../project-handle'

const MAX_REPORTED = 20

// Module-level so a second call during the same run sees the first one. The
// guard is per page, which is exactly the scope that matters: one editor tab
// drives one project.
let compileInFlight = false

function errorSignature(e: { file: string | null; message: string }): string {
  return `${e.file || ''}::${e.message.trim()}`
}

export function computeErrorDelta(
  currentErrors: LogEntrySummary[],
  previousErrors: LogEntrySummary[]
) {
  const previousSignatures = new Set(previousErrors.map(errorSignature))
  const currentSignatures = new Set(currentErrors.map(errorSignature))

  const newErrors = currentErrors.filter(e => !previousSignatures.has(errorSignature(e)))
  const resolvedErrors = previousErrors.filter(e => !currentSignatures.has(errorSignature(e)))

  const countDelta = currentErrors.length - previousErrors.length

  return {
    countDelta,
    newErrors,
    newErrorsCount: newErrors.length,
    resolvedErrorsCount: resolvedErrors.length,
    regressed: countDelta > 0 || newErrors.length > 0,
  }
}

export const compileProjectTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'compile_project',
    description:
      'Build the project and report errors and warnings. Use after edits that could affect the build. Not to see what already failed — get_compile_result shows the last result without rebuilding.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  async execute(_args, handle, options?: { signal?: AbortSignal }) {
    if (compileInFlight) {
      return { error: 'A compile is already in progress. Wait for it to finish.' }
    }

    compileInFlight = true
    try {
      const previous = handle.lastCompile()
      const previousErrors = previous?.errors ?? []

      const outcome = await handle.compile(options)
      const currentErrors = outcome.errors ?? []
      const currentWarnings = outcome.warnings ?? []

      const delta = computeErrorDelta(currentErrors, previousErrors)
      const primaryError = currentErrors.length > 0 ? currentErrors[0] : null
      const cascadingErrorsCount = Math.max(0, currentErrors.length - 1)

      let message: string
      if (currentErrors.length === 0) {
        message = currentWarnings.length > 0
          ? `The project compiled with 0 errors and ${currentWarnings.length} warning(s).`
          : 'The project compiled without errors.'
      } else if (previous && delta.regressed) {
        message = `WARNING: Compilation worsened. Error count changed by ${delta.countDelta >= 0 ? `+${delta.countDelta}` : delta.countDelta} (${delta.newErrorsCount} new error(s) introduced, ${delta.resolvedErrorsCount} resolved). Recent edits likely introduced invalid LaTeX syntax. Focus on fixing the primary error first.`
      } else if (previous && delta.resolvedErrorsCount > 0) {
        message = `The project compiled with ${currentErrors.length} error(s) (${delta.resolvedErrorsCount} error(s) resolved).`
      } else {
        message = `The project compiled with ${currentErrors.length} error(s).`
      }

      return {
        status: outcome.status,
        errorCount: currentErrors.length,
        warningCount: currentWarnings.length,
        errorDelta: previous ? delta.countDelta : 0,
        newErrorsCount: previous ? delta.newErrorsCount : currentErrors.length,
        resolvedErrorsCount: previous ? delta.resolvedErrorsCount : 0,
        regressed: previous ? delta.regressed : false,
        primaryError,
        cascadingErrorsCount,
        errors: currentErrors.slice(0, MAX_REPORTED),
        warnings: currentWarnings.slice(0, MAX_REPORTED),
        message,
      }
    } catch (error: any) {
      return { error: error?.message ?? 'The compile failed to start.' }
    } finally {
      // Always released, or one failure would wedge the tool for the session.
      compileInFlight = false
    }
  },
}
```

- [ ] **Step 4: Verify test passes**

Run:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-tool.test.ts
```
Expected output: 11 passing.

---

### Task 4: Enrich `compile-result.ts` with `includeRaw = true` Default & Cascade Summary

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-result.ts`
- Modify: `modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts`

**The Defect, Precisely:**
`compile-result.ts` defaults `includeRaw = false`. Models querying `get_compile_result` get only the bare error string without raw TeX lines. Setting `includeRaw = true` by default and exposing `primaryError` and `cascadeSummary` gives the model full context immediately. In addition, the tool's `render(result: any)` method must be preserved so human-readable formatting in the UI and tests remains intact.

**TRAP Block:**
- **Trap 1:** Do NOT delete or omit `render(result: any)` from `compileResultTool`. In `compile-log-tool.test.ts:125-132`, `compileResultTool.render!` is directly tested. Omitting it causes a `TypeError: compileResultTool.render is not a function`.
- **Trap 2:** In `compile-log-tool.test.ts` (lines 96-104), the existing test `it('attaches raw log excerpts only when asked')` explicitly asserts that omitting `includeRaw` yields `excerpt: undefined`. When changing the default of `includeRaw` to `true`, this test MUST be replaced with `it('attaches raw log excerpts by default (includeRaw defaults to true)')` and a test for `includeRaw: false`. If not replaced, the existing test fails.

- [ ] **Step 1: Replace and update tests in `compile-log-tool.test.ts`**

In `modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts`, replace the existing test `it('attaches raw log excerpts only when asked', ...)` (lines 96-104) and add new tests:

```ts
  it('attaches raw log excerpts by default (includeRaw defaults to true)', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })

    const result: any = await compileResultTool.execute({}, handle)
    expect(result.errors[0].excerpt).to.include('! Undefined control sequence.')
    expect(result.errors[0].excerpt).to.include('l.3 \\foo')
  })

  it('omits raw log excerpts when explicitly passed includeRaw: false', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })

    const result: any = await compileResultTool.execute({ includeRaw: false }, handle)
    expect(result.errors[0].excerpt).to.equal(undefined)
  })

  it('surfaces primaryError and cascadingErrorsCount', async function () {
    const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })

    const result: any = await compileResultTool.execute({}, handle)
    expect(result.primaryError).to.not.equal(null)
    expect(result.primaryError.message).to.equal('Undefined control sequence.')
    expect(result.cascadingErrorsCount).to.equal(0)
  })
```

- [ ] **Step 2: Implement updates in `compile-result.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-result.ts`, ensure `includeRaw` defaults to `true`, expose `primaryError` and `cascadingErrorsCount`, and keep `render(result: any)`:

```ts
import { AgentTool } from './registry'
import { LogEntrySummary } from '../project-handle'

const DEFAULT_LIMIT = 20
const EXCERPT_RADIUS = 3

/** Finds a log line and returns it with `radius` lines either side. */
export function excerptAround(
  rawLog: string,
  needle: string,
  radius: number
): string | null {
  if (!rawLog || !needle) return null
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
    if (entry.excerpt) return entry
    const excerpt = excerptAround(rawLog, entry.message, EXCERPT_RADIUS)
    return excerpt ? { ...entry, excerpt } : entry
  })
}

export const compileResultTool: AgentTool = {
  suspends: false,
  mutates: false,
  spec: {
    name: 'get_compile_result',
    description:
      'The result of the last build: errors, warnings and raw log excerpts, without rebuilding. Pass severity to narrow and limit to cap the count.',
    parameters: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['errors', 'warnings', 'all'],
          description: 'Which entries to return. Defaults to all.',
        },
        limit: {
          type: 'number',
          description: `Cap per severity. Defaults to ${DEFAULT_LIMIT}.`,
        },
        includeRaw: {
          type: 'boolean',
          description: 'Include raw log lines around each entry. Defaults to true.',
        },
      },
      required: [],
    },
  },

  async execute(
    {
      severity = 'all',
      limit,
      maxEntries,
      includeRaw = true,
    }: {
      severity?: 'errors' | 'warnings' | 'all'
      limit?: number
      maxEntries?: number
      includeRaw?: boolean
    } = {},
    handle
  ) {
    const cap = limit ?? maxEntries ?? DEFAULT_LIMIT
    const compile = handle.lastCompile()

    if (!compile) {
      return {
        status: 'none',
        message:
          'The project has not been compiled in this session. Call compile_project to build it.',
      }
    }

    const rawErrors = compile.errors.slice(0, cap)
    const rawWarnings = compile.warnings.slice(0, cap)

    const decoratedErrors = decorate(rawErrors, compile.rawLog, includeRaw)
    const decoratedWarnings = decorate(rawWarnings, compile.rawLog, includeRaw)

    const primaryError = decoratedErrors.length > 0 ? decoratedErrors[0] : null
    const cascadingErrorsCount = Math.max(0, compile.errors.length - 1)

    const result: Record<string, unknown> = {
      status: compile.status,
      errorCount: compile.errors.length,
      warningCount: compile.warnings.length,
      primaryError,
      cascadingErrorsCount,
      truncated:
        compile.errors.length > rawErrors.length ||
        compile.warnings.length > rawWarnings.length,
    }

    if (severity === 'all' || severity === 'errors') {
      result.errors = decoratedErrors
    }

    if (severity === 'all' || severity === 'warnings') {
      result.warnings = decoratedWarnings
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

- [ ] **Step 3: Verify test passes**

Run:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts
```
Expected output: 15 passing (baseline was 14 passing; 1 replaced + 2 added = 15 passing).

---

### Task 5: Register `get_compile_log` Alias in `registry.ts` and Clean Stale References

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/compile-error.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/fix-run.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts`

**The Defect, Precisely:**
Backend `AiAssistTools.mjs` registers `get_compile_log` as an alias to `get_compile_result` (line 674), and UI components (`tool-call-card.tsx`, `status-words.ts`, `tool-icons.test.tsx`) support `get_compile_log`. However, `TOOLS` in `registry.ts` lacked the `get_compile_log` key, causing tool lookup failures when weak models hallucinate or call `get_compile_log`.

**TRAP Block:**
- **Trap 1:** In `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts:66-68`, `toolSpecs()` is defined as `return Object.values(TOOLS).map(tool => tool.spec)`. Adding `get_compile_log: compileResultTool` directly into `TOOLS` causes `toolSpecs()` to return duplicate tool specs with identical `name: 'get_compile_result'`. When sent to LLM provider APIs (e.g. Anthropic/OpenAI), duplicate tool definitions trigger 400 Bad Request schema validation failures. `toolSpecs()` must deduplicate tool instances using a `Set`: `Array.from(new Set(Object.values(TOOLS))).map(tool => tool.spec)`.

- [ ] **Step 1: Write test for `get_compile_log` alias in registry and spec deduplication**

In `modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts`:

```ts
import { TOOLS, toolSpecs } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'

it('resolves get_compile_log alias in tool registry and deduplicates toolSpecs', async function () {
  expect(TOOLS).to.have.property('get_compile_log')
  expect(TOOLS.get_compile_log).to.equal(TOOLS.get_compile_result)

  const specs = toolSpecs()
  const compileResultSpecs = specs.filter(s => s.name === 'get_compile_result')
  expect(compileResultSpecs).to.have.lengthOf(1)

  const { handle } = createFakeHandle({ docs: { 'main.tex': 'x' }, lastCompile: COMPILE })
  const result: any = await TOOLS.get_compile_log.execute({}, handle)
  expect(result.status).to.equal('failure')
  expect(result.errorCount).to.equal(1)
})
```

- [ ] **Step 2: Add alias and update `toolSpecs()` in `registry.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`, update `TOOLS` map (lines 48-65) and `toolSpecs` (lines 66-68):

```ts
export const TOOLS: Record<string, AgentTool> = {
  get_outline: getOutlineTool,
  get_packages: getPackagesTool,
  get_references: getReferencesTool,
  list_files: listFilesTool,
  read_file: readFileTool,
  search_text: searchTextTool,
  edit_file: editFileTool,
  create_file: createFileTool,
  compile_project: compileProjectTool,
  get_compile_result: compileResultTool,
  get_compile_log: compileResultTool, // Backward-compatible alias
  get_project_settings: getProjectSettingsTool,
  configure_appearance_settings: configureAppearanceSettingsTool,
  configure_compiler_settings: configureCompilerSettingsTool,
  configure_editor_settings: configureEditorSettingsTool,
  list_available_settings: listAvailableSettingsTool,
}

export function toolSpecs(): ToolSpec[] {
  // Deduplicate tools so aliases pointing to the same AgentTool do not emit duplicate tool specs to LLM APIs
  const uniqueTools = Array.from(new Set(Object.values(TOOLS)))
  return uniqueTools.map(tool => tool.spec)
}
```

- [ ] **Step 3: Clean up comments in `compile-error.ts` and `fix-run.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/context/compile-error.ts` (lines 46, 65), replace references to `get_compile_log` with `get_compile_result`.
In `modules/ai-assist/frontend/js/features/ai-assist/agent/fix-run.ts` (line 45), replace `get_compile_log` with `get_compile_result`.

- [ ] **Step 4: Verify test passes**

Run:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts
```
Expected output: 16 passing.

---

### Task 6: Fix `-file-line-error` Mode, Swallowed Errors and Path Normalization in `LatexLogParser.mjs`

**Files:**
- Modify: `modules/ai-assist/app/src/LatexLogParser.mjs`
- Create: `modules/ai-assist/test/unit/src/LatexLogParserTests.mjs`

**The Defect, Precisely:**
1. In `LatexLogParser.mjs` (lines 101-137), when `this.currentLineIsFileLineError()` matches, `parseFileLineError()` extracts `file`, `line`, and `message`. However, if the parser enters `state === STATE.ERROR` and executes `linesUpToNextMatchingLine(/^l\.[0-9]+/)`, TeX in `-file-line-error` mode does not always output `l.<line>` on subsequent lines, causing the line search to overshoot and consume subsequent error lines.
2. In `linesUpToNextMatchingLine` (lines 55-68), `stopAtError` only checks `nextLine.match(/^! /)`. It ignores `FILE_LINE_ERROR_REGEX.test(nextLine)`, swallowing subsequent `-file-line-error` lines.
3. Path names extracted in `-file-line-error` mode often retain build container prefixes (e.g. `/compiles/64f123456789/chapters/abstract.tex`) or `./` prefixes (e.g. `./chapters/intro.tex`). Simply splitting by `/compiles/` leaves the compile directory ID (`64f123456789/chapters/abstract.tex`), which fails to match project-relative paths (`chapters/abstract.tex`).

**TRAP Block:**
- **Trap 1:** Do NOT simply split on `/compiles/` and strip leading slashes. `/compiles/64f123456789/chapters/abstract.tex` has a compile container ID segment. `normalizeFilePath` must strip `/compiles/[^/]+/` and `/tmp/[^/]+/` to yield `chapters/abstract.tex`.
- **Trap 2:** `FILE_LINE_ERROR_REGEX` is defined in module scope in `LatexLogParser.mjs:9` (`/^([./].*):(\d+): (.*)/`). `LogText.linesUpToNextMatchingLine` can access `FILE_LINE_ERROR_REGEX` directly in module scope.

- [ ] **Step 1: Write the failing Vitest unit test**

Create `modules/ai-assist/test/unit/src/LatexLogParserTests.mjs`:

```js
import { describe, it } from 'vitest'
import { expect } from 'chai'
import { LatexLogParser } from '../../../app/src/LatexLogParser.mjs'

describe('LatexLogParser -file-line-error handling', () => {
  it('parses consecutive -file-line-error entries without swallowing lines', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653-2.6-1.40.24 (TeX Live 2022)',
      'entering extended mode',
      './main.tex:14: Undefined control sequence.',
      'l.14 \\undefinedmacro',
      './sections/intro.tex:25: Missing $ inserted.',
      '<inserted text>',
      '                $',
      'l.25 \\begin{equation}',
      '(./main.aux)',
      ')',
      'Output written on main.pdf (1 page, 1000 bytes).',
    ].join('\n')

    const result = LatexLogParser.parse(log)

    expect(result.errors).to.have.length(2)
    expect(result.errors[0].file).to.equal('main.tex')
    expect(result.errors[0].line).to.equal(14)
    expect(result.errors[0].message).to.equal('Undefined control sequence.')

    expect(result.errors[1].file).to.equal('sections/intro.tex')
    expect(result.errors[1].line).to.equal(25)
    expect(result.errors[1].message).to.equal('Missing $ inserted.')
  })

  it('normalizes container prefixes and leading ./ from file paths', () => {
    const log = [
      '/compiles/64f123456789/chapters/abstract.tex:5: LaTeX Error: Environment foo undefined.',
    ].join('\n')

    const result = LatexLogParser.parse(log)
    expect(result.errors).to.have.length(1)
    expect(result.errors[0].file).to.equal('chapters/abstract.tex')
    expect(result.errors[0].line).to.equal(5)
  })
})
```

- [ ] **Step 2: Run test to confirm failure**

```bash
NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/LatexLogParserTests.mjs
```

- [ ] **Step 3: Fix `LatexLogParser.mjs`**

In `modules/ai-assist/app/src/LatexLogParser.mjs`:

1. Update `linesUpToNextMatchingLine` (lines 55-68) to stop at `FILE_LINE_ERROR_REGEX`:
```javascript
  linesUpToNextMatchingLine(match, stopAtError = false) {
    const lines = []
    while (true) {
      const nextLine = this.nextLine()
      if (nextLine === false) break
      if (stopAtError && (nextLine.match(/^! /) || FILE_LINE_ERROR_REGEX.test(nextLine))) {
        this.rewindLine()
        break
      }
      lines.push(nextLine)
      if (nextLine.match(match)) break
    }
    return lines
  }
```

2. Add path normalization helper to `LatexLogParser` class:
```javascript
  normalizeFilePath(filePath) {
    if (!filePath) return filePath
    let cleaned = filePath.trim()
    // Strip leading ./
    cleaned = cleaned.replace(/^\.\//, '')
    // Strip container compile prefixes like /compiles/<id>/ or /tmp/<id>/
    cleaned = cleaned.replace(/^\/compiles\/[^/]+\//, '')
    cleaned = cleaned.replace(/^\/tmp\/[^/]+\//, '')
    for (const regex of this.fileBaseNames) {
      if (regex.test(cleaned)) {
        const parts = cleaned.split(regex)
        const remainder = parts[parts.length - 1].replace(/^\/+/, '')
        if (regex.source.includes('compiles') || regex.source.includes('tmp')) {
          cleaned = remainder.replace(/^[^/]+\//, '')
        } else {
          cleaned = remainder
        }
      }
    }
    return cleaned.replace(/^\/+/, '')
  }
```

3. Update `parseFileLineError` (lines 170-181):
```javascript
  parseFileLineError() {
    const result = this.currentLine.match(FILE_LINE_ERROR_REGEX)
    if (!result) return
    this.currentError = {
      line: parseInt(result[2], 10) || null,
      file: this.normalizeFilePath(result[1]),
      level: 'error',
      message: result[3],
      content: '',
      raw: this.currentLine + '\n',
    }
  }
```

4. Update `parse()` loop (lines 101-137) to handle `-file-line-error` without unbounded line eating:
```javascript
        } else if (this.currentLineIsFileLineError()) {
          this.parseFileLineError()
          if (this.currentError) {
            // Collect immediate context lines up to next error or whitespace
            const contextLines = this.log.linesUpToNextWhitespaceLine(true)
            if (contextLines.length > 0) {
              this.currentError.content += contextLines.join('\n') + '\n'
              this.currentError.raw += this.currentError.content
            }
            this.data.push(this.currentError)
            this.currentError = undefined
          }
          this.state = STATE.NORMAL
        }
```

- [ ] **Step 4: Verify Vitest unit test passes**

```bash
NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/LatexLogParserTests.mjs
```
Expected output: 1 passed (2 tests).

---

### Task 7: Mirror Regression Delta and Raw Log Excerpts in Backend `AiAssistTools.mjs`

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs`
- Modify: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`

**The Defect, Precisely:**
Backend background runs executed via `AiAssistTools.mjs` must maintain 100% behavioral parity with frontend `compile_project` and `get_compile_result` tools:
1. `compile_project` must compute error deltas against `this.lastCompileResult.get(projectId)` before storing the new compile outcome.
2. It must return `primaryError`, `cascadingErrorsCount`, `errorDelta`, `newErrorsCount`, `resolvedErrorsCount`, `regressed`, and attach `excerpt` to errors when raw TeX log is available.
3. `get_compile_result` / `get_compile_log` must default `includeRaw` to `true` (rather than `false`), and include `primaryError` and `cascadingErrorsCount`.

- [ ] **Step 1: Write the failing unit tests in `AiAssistTools.test.mjs`**

In `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`, add tests for backend `compile_project` delta tracking and `get_compile_result` default excerpts:

```js
  it('reports error deltas and regressed flag in compile_project', async function () {
    const validUserId = '012345678901234567890123'
    const log1 = [
      './main.tex:10: Undefined control sequence.',
      'l.10 \\foo',
    ].join('\n')

    tools.clsiManager = {
      getOutputFileStream: sinon.stub().resolves([Buffer.from(log1)]),
    }
    mockCompileManager.compile.resolves({
      status: 'failure',
      buildId: 'b1',
      clsiServerId: 's1',
      outputFiles: [{ path: 'output.log' }],
    })

    const firstCompile = await tools.execute('compile_project', {}, { projectId: 'p1', userId: validUserId })
    expect(firstCompile.status).to.equal('failure')
    expect(firstCompile.errorCount).to.equal(1)
    expect(firstCompile.errorDelta).to.equal(0)
    expect(firstCompile.primaryError.message).to.equal('Undefined control sequence.')

    // Second compile introduces an additional error
    const log2 = [
      './main.tex:15: Undefined control sequence.',
      'l.15 \\foo',
      './main.tex:20: Missing $ inserted.',
      'l.20 $',
    ].join('\n')
    tools.clsiManager.getOutputFileStream = sinon.stub().resolves([Buffer.from(log2)])

    const secondCompile = await tools.execute('compile_project', {}, { projectId: 'p1', userId: validUserId })
    expect(secondCompile.errorCount).to.equal(2)
    expect(secondCompile.errorDelta).to.equal(1)
    expect(secondCompile.newErrorsCount).to.equal(1)
    expect(secondCompile.regressed).to.equal(true)
    expect(secondCompile.message).to.match(/WARNING: Compilation worsened/i)
    expect(secondCompile.cascadingErrorsCount).to.equal(1)
  })

  it('defaults includeRaw to true in get_compile_result', async function () {
    const validUserId = '012345678901234567890123'
    const log = [
      './main.tex:10: Undefined control sequence.',
      'l.10 \\foo',
    ].join('\n')

    tools.clsiManager = {
      getOutputFileStream: sinon.stub().resolves([Buffer.from(log)]),
    }
    mockCompileManager.compile.resolves({
      status: 'failure',
      buildId: 'b1',
      clsiServerId: 's1',
      outputFiles: [{ path: 'output.log' }],
    })

    await tools.execute('compile_project', {}, { projectId: 'p1', userId: validUserId })
    const res = await tools.execute('get_compile_result', {}, { projectId: 'p1', userId: validUserId })

    expect(res.status).to.equal('failure')
    expect(res.primaryError).to.not.equal(null)
    expect(res.errors[0].excerpt).to.include('l.10 \\foo')
  })
```

- [ ] **Step 2: Run test to confirm failure**

```bash
NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs
```

- [ ] **Step 3: Implement parity updates in `AiAssistTools.mjs`**

In `modules/ai-assist/app/src/AiAssistTools.mjs`:

1. Add `errorSignature` and `computeErrorDelta` helper functions (near line 95):

```javascript
export function errorSignature(e) {
  return `${e.file || ''}::${(e.message || '').trim()}`
}

export function computeErrorDelta(currentErrors = [], previousErrors = []) {
  const previousSignatures = new Set(previousErrors.map(errorSignature))
  const currentSignatures = new Set(currentErrors.map(errorSignature))

  const newErrors = currentErrors.filter(e => !previousSignatures.has(errorSignature(e)))
  const resolvedErrors = previousErrors.filter(e => !currentSignatures.has(errorSignature(e)))

  const countDelta = currentErrors.length - previousErrors.length

  return {
    countDelta,
    newErrors,
    newErrorsCount: newErrors.length,
    resolvedErrorsCount: resolvedErrors.length,
    regressed: countDelta > 0 || newErrors.length > 0,
  }
}
```

2. Update `compile_project` and `get_compile_result` handling (lines 614-725):

```javascript
      case 'compile_project': {
        const result = await this.compileManager.compile(projectId, userId, {})
        let errors = []
        let warnings = []
        let rawLog = ''

        const logFile = (result.outputFiles || []).find(f => f.path === 'output.log' || f.path?.endsWith('.log'))
        if (logFile && result.buildId && this.clsiManager?.getOutputFileStream) {
          try {
            const stream = await this.clsiManager.getOutputFileStream(
              projectId,
              userId,
              result.clsiServerId,
              result.buildId,
              logFile.path
            )
            const chunks = []
            for await (const chunk of stream) chunks.push(chunk)
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
            warnings = (parsed.warnings || []).map(w => ({
              file: w.file || null,
              line: typeof w.line === 'number' ? w.line : (parseInt(w.line, 10) || null),
              message: w.message || '',
            }))
          } catch (err) {
            // Log fetch failure is non-fatal
          }
        }

        const compileStatus = errors.length > 0 ? 'failure' : (result.status === 'success' ? 'success' : result.status)
        const previous = this.lastCompileResult.get(projectId)
        const previousErrors = previous?.errors || []

        this.lastCompileResult.set(projectId, {
          status: compileStatus,
          errors,
          warnings,
          rawLog,
        })

        const delta = computeErrorDelta(errors, previousErrors)
        const primaryError = errors.length > 0 ? errors[0] : null
        const cascadingErrorsCount = Math.max(0, errors.length - 1)

        let message
        if (errors.length === 0) {
          message = warnings.length > 0
            ? `The project compiled with 0 errors and ${warnings.length} warning(s).`
            : 'The project compiled without errors.'
        } else if (previous && delta.regressed) {
          message = `WARNING: Compilation worsened. Error count changed by ${delta.countDelta >= 0 ? `+${delta.countDelta}` : delta.countDelta} (${delta.newErrorsCount} new error(s) introduced, ${delta.resolvedErrorsCount} resolved). Recent edits likely introduced invalid LaTeX syntax. Focus on fixing the primary error first.`
        } else if (previous && delta.resolvedErrorsCount > 0) {
          message = `The project compiled with ${errors.length} error(s) (${delta.resolvedErrorsCount} error(s) resolved).`
        } else {
          message = `The project compiled with ${errors.length} error(s) and ${warnings.length} warning(s).`
        }

        const maxReported = 20
        return {
          status: compileStatus,
          errorCount: errors.length,
          warningCount: warnings.length,
          errorDelta: previous ? delta.countDelta : 0,
          newErrorsCount: previous ? delta.newErrorsCount : errors.length,
          resolvedErrorsCount: previous ? delta.resolvedErrorsCount : 0,
          regressed: previous ? delta.regressed : false,
          primaryError,
          cascadingErrorsCount,
          errors: errors.slice(0, maxReported),
          warnings: warnings.slice(0, maxReported),
          message,
        }
      }

      case 'get_compile_result':
      case 'get_compile_log': {
        let compile = this.lastCompileResult.get(projectId)
        if (!compile) {
          try {
            await this.execute('compile_project', {}, { projectId, userId: rawUserId })
            compile = this.lastCompileResult.get(projectId)
          } catch {
            // ignore
          }
        }

        if (!compile) {
          return {
            status: 'none',
            message: 'The project has not been compiled in this session. Call compile_project to build it.',
          }
        }

        const severity = args.severity || 'all'
        const limit = args.limit || args.maxEntries || 20
        const includeRaw = args.includeRaw !== undefined ? Boolean(args.includeRaw) : true

        const errors = compile.errors.slice(0, limit)
        const warnings = compile.warnings.slice(0, limit)

        const decorate = (entries) => {
          if (!includeRaw || !compile.rawLog) return entries
          return entries.map(e => {
            if (e.excerpt) return e
            const excerpt = excerptAround(compile.rawLog, e.message, 3)
            return excerpt ? { ...e, excerpt } : e
          })
        }

        const decoratedErrors = decorate(errors)
        const decoratedWarnings = decorate(warnings)
        const primaryError = decoratedErrors.length > 0 ? decoratedErrors[0] : null
        const cascadingErrorsCount = Math.max(0, compile.errors.length - 1)

        const outcome = {
          status: compile.status,
          errorCount: compile.errors.length,
          warningCount: compile.warnings.length,
          primaryError,
          cascadingErrorsCount,
          truncated: compile.errors.length > limit || compile.warnings.length > limit,
        }

        if (severity === 'all' || severity === 'errors') {
          outcome.errors = decoratedErrors
        }
        if (severity === 'all' || severity === 'warnings') {
          outcome.warnings = decoratedWarnings
        }

        return outcome
      }
```

- [ ] **Step 4: Verify backend unit tests pass**

```bash
NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs
```
Expected output: 1 passed (15 tests).

---

## Out of Scope for Workstream 4

- **Editor Bridge & Document Switching:** Handled strictly in **Workstream 1**.
- **Character-Offset Replacement & Append Mode (`oldText: ""`):** Handled strictly in **Workstream 2**.
- **LaTeX Matcher Parity & Line Number Prefix Stripping (`14: `):** Handled strictly in **Workstream 3**.
- **Project Indexing & Structural Search Filters:** Handled strictly in **Workstream 5**.

---

## Verification & Baseline Protocol

After completing all tasks, execute the full test suites from `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`:

1. **Frontend Mocha Test Suite:**
   ```bash
   NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend
   ```
   **Requirement:** All tests passing (≥778 passing, 0 failing).

2. **Backend Vitest Test Suite:**
   ```bash
   NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
   ```
   **Requirement:** All test files passing (11 test files, ≥110 tests passing, 0 failing).
