# AI Assist Editor Tooling & Harness Redesign Specification

**Date:** 2026-09-16
**Topic:** Overleaf AI Assist Editor Tooling, Anchor Resolution, Compilation Feedback Loop & Document Integrity Architecture
**Status:** Approved
**Implementation Plans:**
- [/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws1-bridge-path-targeting.md](/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws1-bridge-path-targeting.md) (Workstream 1: Editor Bridge & Path-Targeted Document Mutation)
- [/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws2-precision-anchor-apply.md](/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws2-precision-anchor-apply.md) (Workstream 2: Precision Anchor Resolution & Non-Destructive Code Replacement)
- [/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws3-latex-matcher-parity.md](/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws3-latex-matcher-parity.md) (Workstream 3: Robust LaTeX Matching & Schema Ambiguity Resolution)
- [/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws4-compile-feedback-loop.md](/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws4-compile-feedback-loop.md) (Workstream 4: Compiler Feedback Loop, Delta Tracking & Log Diagnostic Enrichment)
- [/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws5-context-search-hygiene.md](/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/plans/2026-09-16-ai-assist-editor-tooling-ws5-context-search-hygiene.md) (Workstream 5: Context Indexing, Structural Search & Harness Hygiene)

---

## 1. Executive Summary & Root Cause Narrative

### 1.1 The Symptom and the Fallacy
When users ask the Overleaf AI Assistant (both the main chat agent and the single-turn compile-log fix runner) to resolve LaTeX compilation errors or perform document edits, the assistant frequently produces broken edits, corrupts multi-file projects, duplicates document headers, injects foreign code into unrelated files, and gets trapped in catastrophic regression loops.

A superficial inspection might blame the underlying Large Language Model (LLM) — attributing failures to poor LaTeX reasoning, hallucinated syntax, or non-compliance with system prompt instructions. **This attribution is fundamentally incorrect.**

An exhaustive architectural audit reveals that the assistant fails because of **compounding infrastructural defects across the editor bridge, string-anchor matching, document switching, and compiler feedback subsystems**. The write path actively corrupts project files, and the compilation tool misreports build outcomes by returning stale errors from prior runs. Under these conditions, even a mathematically flawless model cannot succeed.

### 1.2 The Four Compounding Failure Layers

```
+-----------------------------------------------------------------------------+
| Layer 1: Target File Disconnect & Document Bleed                            |
| Model targets 'chapters/intro.tex' -> Bridge reads active tab ('main.tex')  |
| Edit applied blindly to active tab -> main.tex corrupted with foreign text  |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| Layer 2: Fragile Line-Granular Clashing & Broken Append                     |
| Surgical sub-line edit converted to whole-line range -> Drift check fails   |
| Append mode (oldText: "") matches EOF but slice !== "" -> Always rejected  |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| Layer 3: Diagnostic Blindness & Tokenization Parity Gap                     |
| Frontend lacks JSON unescaping & LaTeX normalisation -> noMatch/ambiguous   |
| Model receives zero line cues; newText poisoned by raw line-number prefixes |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| Layer 4: Async Compile Race & Cascading Regression Spirals                  |
| compile_project does not await build; polls stale logEntriesRef.current     |
| Model sees old errors -> thinks edit failed -> makes more destructive edits |
+-----------------------------------------------------------------------------+
```

1. **Target File Disconnect & Document Bleed (Critical Path Corruption):**
   When a compilation error occurs in a subfile (e.g. `chapters/intro.tex`), the model issues `edit_file` with `path: "chapters/intro.tex"`. In `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts` (lines 487-528), `proposeEdit` unconditionally invokes `readDocOverBridge()` without passing the target path. In `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx`, the bridge listener responds with the text of whatever document is currently active in CodeMirror 6 (almost always `main.tex`). `proposeEdit` locates the anchor in `main.tex`, computes line numbers relative to `main.tex`, triggers an unsynchronized `openDocWithId` that is not awaited, and dispatches the edit over the bridge. The bridge immediately applies the replacement to `main.tex`. As a result, chapter-specific text is injected into `main.tex`, corrupting the root document.
   Even more severely, when `create_file` is invoked (`use-project-handle.ts` lines 586-624), the backend creates a doc entity, but `createFile` immediately dispatches an edit with `startLine: 1` over the bridge into the open tab (`main.tex`), overwriting line 1 of `main.tex` with the new file content!

2. **Fragile Matching & Destructive Line Clashing:**
   When models make surgical intra-line changes (e.g., fixing `\cite{key}` to `\cite{key2}` within a 150-character paragraph), `spanToLineRange` converts character offsets into whole-line ranges. In `apply-fix-listener.tsx` (lines 87-113), the bridge tests the entire line array against the sub-line `oldText` (`current.slice(from - 1, to).join('\n') !== oldText`), which immediately fails with `'drifted'`. If an edit replaces multiple lines, `lineRangeToOffsets` replaces from start-of-first-line to end-of-last-line, obliterating untouched code on shared lines.
   Append mode (`oldText: ""`) is completely non-functional: `spanToText` resolves index to `text.length`, but `apply-fix-listener` compares `current.slice(from - 1, to).join('\n')` against `""`, which evaluates to false on any non-empty trailing line, rejecting all file appends as `'drifted'`. Furthermore, when `oldText` ends in a newline (`\n`), `spanToLineRange` counts an extra line, causing deletions of subsequent unrelated code.

3. **Frontend LaTeX Matching & Diagnostic Blindness:**
   The backend matcher contains comprehensive LaTeX tokenization and backslash unescaping (`\\cmd` -> `\cmd`), but the frontend `edit-file.ts` (lines 11-86) uses naive string matching. When models emit JSON-escaped LaTeX strings, anchor matching returns `noMatch`. The frontend error return (`edit-file.ts` lines 166-178) provides zero diagnostic feedback, candidate lines, or line numbers.
   Misled by stale tool specifications that falsely advised passing `oldText: ""` to replace an entire file, models repeatedly append duplicate preambles (`\documentclass...\begin{document}`). Additionally, when models copy lines from `read_file` or `fix-source` (formatted as `14: \usepackage{...}`), the absence of line-number sanitization results in raw `14: ` prefixes being permanently written into the LaTeX source.

4. **Asynchronous Compile Race & Regression Spirals:**
   In `use-project-handle.ts` (lines 537-558), `compile()` calls `startCompile()` without awaiting its promise. `startCompile()` delegates to `compiler.compile()` in `frontend/js/shared/context/local-compile-context.tsx` (lines 693-699). In `local-compile-context.tsx` (lines 512-525), `setLogEntries(undefined)` is executed only when the compile HTTP response arrives, while `handleLogFiles` parses logs in a subsequent asynchronous promise.
   Because `use-project-handle.ts` polls `logEntriesRef.current` starting at 500ms, and `logEntriesRef.current` still holds the error list from the *previous* compilation run, `compile()` immediately returns the pre-edit errors. The model assumes its edit had no effect, makes another destructive edit, and enters an inescapable regression loop.
   When compilation finally completes, `compile_project` strips raw log excerpts, omits root-cause cascade classification, and provides no before/after error delta (`errorDelta`, `newErrors`). A single unclosed brace causes 15 downstream errors; the model attempts to fix downstream hallucinations and destroys the document.

---

## 2. Confirmed Findings

All 34 findings confirmed by the architectural audit are categorized by severity below. Every finding has been mapped to its remediation workstream and verified against the current repository state.

| # | Severity | Finding Title | File & Verified Line(s) | Symptom Link | Workstream |
|---|---|---|---|---|---|
| 1 | **Critical** | Bridge reads and edits currently open editor tab regardless of target file path | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:487-528` | Secondary file edits applied to `main.tex` | WS1 |
| 2 | **Critical** | Sub-line edits fail drift check or wipe out entire surrounding lines | `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx:87-113` | Surgical fixes rejected as 'drifted' | WS2 |
| 3 | **Critical** | `create_file` applies content to line 1 of currently open document instead of new file | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:586-624` | New file content overwrites line 1 of active tab | WS1 |
| 4 | **Critical** | `edit_file` searches and applies edits against currently open document | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:485-535` | In-memory anchor match done on wrong file | WS1 |
| 5 | **Critical** | `compile()` returns stale or partial compile results without awaiting build completion | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:537-558` | Immediate return of pre-edit errors | WS4 |
| 6 | **High** | Append mode (`oldText: ""`) is completely broken and always returns 'drifted' | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:38-41, 508-528` | Cannot append packages or bibliographies | WS2 |
| 7 | **High** | Unsynchronized document switch races `applyEditOverBridge` event dispatch | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:515-528` | Edit applied before CodeMirror switches doc | WS1 |
| 8 | **High** | Contradictory tool spec causes full-file replacements to append duplicate LaTeX | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts:116-155` | Duplicate preambles added to broken files | WS3 |
| 9 | **High** | Compile tools omit source code context and default `includeRaw` to false | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-project.ts:28-38` | Model edits blindly without error line source | WS4 |
| 10 | **High** | Root-cause vs downstream cascade error separation missing from compile tools | `modules/ai-assist/frontend/js/features/ai-assist/agent/context/compile-error.ts:28-89` | 15 cascading errors derail agent | WS4 |
| 11 | **High** | No before/after error delta or regression detection in `compile_project` | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-project.ts:20-45` | Model cannot tell if edit helped or hurt | WS4 |
| 12 | **High** | `LatexLogParser` misattributes line numbers and swallows errors in `-file-line-error` | `modules/ai-assist/app/src/LatexLogParser.mjs:101-137` | Log parser loses line numbers for TeX errors | WS4 |
| 13 | **High** | Frontend `edit_file` error returns zero diagnostic or line-number feedback | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts:166-178` | Model receives no clues on anchor mismatch | WS3 |
| 14 | **High** | Frontend lacks LaTeX token matching and double-backslash unescaping | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts:11-86` | Double-escaped `\\cmd` fails anchor match | WS3 |
| 15 | **High** | Append mode (`oldText: ""`) systematically rejected as 'drifted' by listener | `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx:98-111` | Slice comparison against empty string fails | WS2 |
| 16 | **High** | `search_text` applies 50-hit cap project-wide before glob filtering | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:446-473` | False negative searches when hitting limit | WS5 |
| 17 | **High** | `read_file` and `fix-source` line-number prefixing contaminates model edit output | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts:4-6, 65` & `agent/fix-run.ts:111-137` *(corrected)* | Raw `14: ` prefixes written to LaTeX | WS3 |
| 18 | **High** | `edit_file` parameter overloading allows accidental file appends | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts:90-116` | Missing `oldText` defaults to append | WS3 |
| 19 | **High** | Off-by-one line calculation in `spanToLineRange` for newline-terminated anchors | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:118-126` | Trailing `\n` causes deletion of next line | WS2 |
| 20 | **High** | `createFile` in `use-project-handle` applies content to active doc via bridge | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:589-618` | Bridge injection overwrites active tab | WS1 |
| 21 | **Medium** | Missing delete primitives and newline artifacts during block deletion | `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx:12-20` | Block deletion leaves stray blank lines | WS2 |
| 22 | **Medium** | `get_packages` and `scanPackages` strip package options and lack engine context | `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-index.ts:94-102` | Package options (`[utf8]`) stripped | WS5 |
| 23 | **Medium** | Stale tool name `get_compile_log` in `compile_project` tool description | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-project.ts:14-18` | Model hallucinates calls to non-existent tool | WS4 |
| 24 | **Medium** | `search_text` parameter schema omits `path` argument supported in code | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/search-text.ts:30-58` | Schema validation fails when passing `path` | WS5 |
| 25 | **Medium** | Tier-3 `findUniqueSpan` window corruption when `oldText` contains blank lines | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:90-113` | Empty line filtering shifts line indexing | WS2 |
| 26 | **Medium** | Bridge timeout is erroneously classified as document content drift | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:226-249` | Infrastructure lag reported as 'drifted' | WS1 |
| 27 | **Medium** | `create_file` silently places files in root folder when parent dir missing | `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:182-193` | `sections/ch1.tex` created as `/ch1.tex` | WS1 |
| 28 | **Medium** | `edit_file` lacks line-addressed replacement fallback for ambiguous anchors | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts:96-109` | Repeated equations/table rows uneditable | WS3 |
| 29 | **Medium** | `get_outline` produces unbounded line ranges and multi-file slicing errors | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-outline.ts:58-74` | Section end line spans across file boundaries | WS5 |
| 30 | **Medium** | `compile_project` lacks regression delta analysis against previous state | `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-project.ts:20-42` | No feedback on error count increase | WS4 |
| 31 | **Low** | Initial `project-context` envelope hides file paths behind directory counts | `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-context.ts:24-58` | Model does not know full project file tree | WS5 |
| 32 | **Low** | Aggressive run abortion on anchor failures aborts agent loop without recovery | `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts:231-258` | Turn aborted after 2 failed anchor matches | WS5 |
| 33 | **Low** | Non-unique tool call IDs from `Date.now()` and hardcoded `text-1` | `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts:149, 273` | Colliding IDs break provider message pairing | WS5 |
| 34 | **Low** | Zero test coverage for real `useProjectHandle` CodeMirror bridge paths | `modules/ai-assist/test/frontend/js/agent/helpers/fake-handle.ts:1-216` | Real bridge regressions bypass unit tests | WS5 |

*Note on Line Corrections:* Finding #17 in the audit referenced `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts:4-6, 94-98`. `read-file.ts` is 81 lines total. Lines 4-6 define the `number()` helper (invoked on line 65). The second source of line number prefixing is `modules/ai-assist/frontend/js/features/ai-assist/agent/fix-run.ts:111-137` in `readFixSource` and `renderSourceWindow`. Both are documented and addressed in WS3.

---

## 3. Deep-Dive Analysis of the Five Critical Defects

### 3.1 Defect 1: Editor Bridge Targets Active Tab Regardless of Requested Path
**Location:** `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:487-528` & `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx:87-113`

```typescript
// use-project-handle.ts:487
const bridgeText = await readDocOverBridge() // No path argument passed!
let content = bridgeText
```

When `readDocOverBridge()` is called, it dispatches a window event `ol-ai-assist-read-doc`. In `apply-fix-listener.tsx`, the listener simply reads `view.state.doc.toString()` from the currently mounted CodeMirror 6 editor instance.
- If the user has `main.tex` open, `readDocOverBridge()` returns the text of `main.tex`.
- If the model requested an edit to `chapters/intro.tex`, `proposeEdit` searches for the anchor inside `main.tex` content.
- If a match is found (or if `oldText: ""` is used), line numbers `from` and `to` are calculated against `main.tex`.
- `use-project-handle.ts` calls `openDocWithId(entity.entity._id)` (lines 515-520) but **does not await** the document switch or CodeMirror view remount.
- It immediately calls `applyEditOverBridge(...)` (line 528).
- The bridge listener receives the event while CodeMirror is still displaying `main.tex`, and dispatches a transaction replacing lines `from` to `to` in `main.tex` with content intended for `chapters/intro.tex`.

**The Solution:**
1. Parameterize `readDocOverBridge(path: string, docId?: string)` to check whether the requested document is currently active in CodeMirror.
2. If the target document is active, read and mutate via the bridge.
3. If the target document is in the background, await an explicit document switch with a readiness handshake (`ol-ai-assist-doc-ready`), or mutate the document snapshot directly via backend project handle mutation and reload the doc snapshot.
4. If a bridge request times out, return a distinct `'timeout'` status rather than falsely reporting `'drifted'`.

---

### 3.2 Defect 2: Line-Granular Replacements Destroy Code; Broken Append Mode
**Location:** `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx:87-113`, `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:38-41, 118-126`

```typescript
// apply-fix-listener.tsx:98-102
if (current.slice(from - 1, to).join('\n') !== oldText) {
  return respond('drifted')
}
```

1. **Intra-Line Destruction:**
   `spanToLineRange` converts character spans into line ranges `[from, to]`. When a model provides a sub-line `oldText` (e.g. `\textbf{abc}` within a longer paragraph), `current.slice(from - 1, to).join('\n')` extracts the entire line (e.g. `This is a paragraph with \textbf{abc} in the middle.`). Comparing the whole line against `\textbf{abc}` returns false, rejecting the edit as `'drifted'`.
2. **Broken Append Mode:**
   When `oldText: ""` is passed, `findUniqueSpan` returns `{ status: 'found', index: text.length }`. `spanToLineRange` produces `from = doc.lines, to = doc.lines`.
   In `apply-fix-listener.tsx`, `current.slice(from - 1, to).join('\n')` returns the content of the final line of the document (e.g. `\end{document}`). Comparing `\end{document} !== ""` evaluates to `true`, causing every append operation to be rejected as `'drifted'`.
3. **Trailing Newline Off-By-One:**
   In `use-project-handle.ts` (lines 123-124):
   ```typescript
   const from = text.slice(0, index).split('\n').length
   const to = text.slice(0, index + length).split('\n').length
   ```
   If `oldText` ends with `\n` (length includes the newline), `text.slice(0, index + length).split('\n').length` counts into the *next* line. `to` becomes `line + 1`, and CodeMirror replaces one line too many, deleting the following line of valid LaTeX.

**The Solution:**
1. Upgrade `apply-fix-listener.tsx` and `use-project-handle.ts` to support character-level offset replacements alongside line-level replacements.
2. In `apply-fix-listener.tsx`, detect `oldText === ""` as append mode: insert at `view.state.doc.length` without comparing the trailing line text.
3. Fix `spanToLineRange` boundary calculations when `index + length` lands on a newline delimiter.
4. Support clean deletion primitives that remove whole lines without leaving blank empty lines or orphaned newline artifacts.

---

### 3.3 Defect 3: `create_file` Overwrites Line 1 of Active Document Tab
**Location:** `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:586-624`

```typescript
// use-project-handle.ts:586-591
const createFile = useCallback(
  async (request: { path: string; content: string }): Promise<EditOutcome> => {
    const approval = await requestApproval(
      { path: request.path, oldText: '', newText: request.content },
      { startLine: 1 }
    )
```

When `create_file` is invoked:
1. `createFile` asks the user for approval with `{ path: request.path, oldText: '', newText: request.content }` and `{ startLine: 1 }`.
2. After approval, it invokes `createEntity(norm, 'doc', parentFolderId)`. The backend creates a doc entity in the project tree.
3. Then, on lines 609-618, `createFile` attempts to write the initial file content:
   ```typescript
   if (openDocWithId) {
     openDocWithId(newDocId)
   }
   const result = await applyEditOverBridge({
     from: 1,
     to: 1,
     oldText: '',
     replacement: request.content,
   })
   ```
4. `openDocWithId(newDocId)` triggers an asynchronous document switch in React/Angular state.
5. Without waiting for the editor to mount the new document, `applyEditOverBridge` immediately fires.
6. The active editor (`main.tex`) receives the event and inserts `request.content` at line 1 of `main.tex`!

**The Solution:**
1. Decouple initial file content initialization from the CodeMirror bridge: write initial content directly into the document creation payload or backend doc store.
2. If bridge synchronization is required, await document switch completion before dispatching content insertion.
3. Verify parent folder existence before entity creation (`folderIdForPath`) and create missing intermediate directories recursively.

---

### 3.4 Defect 4: `compile_project` Returns Stale Errors via Async Race
**Location:** `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts:537-558` & `frontend/js/shared/context/local-compile-context.tsx:500-555, 693-699`

#### Verified Asynchronous Execution Flow:

```
[use-project-handle.ts]                [local-compile-context.tsx]            [LaTeX Compiler Backend]
         |                                           |                                     |
1. compile() called                                  |                                     |
         |-- startCompile() (NOT AWAITED) ---------->|                                     |
         |                                           |-- compiler.compile() -------------->| (HTTP POST /compile)
2. Enters while loop                                 |                                     |
   start = Date.now()                                |                                     |
   await setTimeout(500ms)                           |                                     |
         |                                           |                                     |
3. 500ms elapsed:                                    |                                     |
   current = logEntriesRef.current                   |                                     |
   *** STILL CONTAINS PRE-EDIT ERRORS ***            |                                     |
   if (current.errors.length > 0)                    |                                     |
     return toCompileOutcome(current) <--- STALE!    |                                     |
         |                                           |                                     |
         | (Model receives old errors & panics)      |                                     |
         |                                           |                                     |
         |                                           |                                     |
         |                                   4. HTTP Response arrives                      |
         |                                      setFileList(...)                           |
         |                                      setLogEntries(undefined)                   |
         |                                      handleLogFiles(...).then(result => {       |
         |                                        setLogEntries(result.logEntries)         |
         |                                      })                                         |
         |                                   5. React re-render:                           |
         |                                      logEntriesRef.current = logEntries (NEW)   |
```

1. In `use-project-handle.ts` (line 542), `startCompile()` is called without `await`.
2. In `local-compile-context.tsx` (lines 693-696), `startCompile` returns `compiler.compile(options)`.
3. While the HTTP compile request is inflight over the network, `use-project-handle.ts` waits 500ms on line 549.
4. On line 550, `logEntriesRef.current` still holds the `logEntries` object from the previous build.
5. Line 551 checks `if (current && (current.errors?.length > 0 || current.all?.length > 0))`, which evaluates to `true`.
6. `compile()` immediately returns `toCompileOutcome(current)` — delivering stale errors that were present before the edit was made.
7. The model sees the same error, assumes its edit failed, and tries a more drastic edit (often deleting code or hallucinating packages).

**The Solution:**
1. In `use-project-handle.ts`, await `startCompile()` and track a compilation generation ID or clear `logEntriesRef.current` immediately when compilation is initiated.
2. Poll until the new compilation cycle resolves and `handleLogFiles` completes log parsing.
3. Enrich compile outcomes with:
   - `errorDelta`: change in error count relative to previous compile (`before: 3, after: 1, resolved: 2, new: 0`).
   - `newErrors`: errors introduced by the latest edit.
   - Raw TeX log excerpt (`l.<line>`) and context lines around the error line.
   - Primary vs cascading error classification.

---

### 3.5 Defect 5: Frontend Matcher Lacks Backend LaTeX Normalisation
**Location:** `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts:11-86`

When an LLM generates a tool call to edit LaTeX, backslashes are often escaped or normalized differently:
- JSON transport produces `\\textbf{heading}`.
- LaTeX source contains `\textbf{heading}`.
- The model might omit whitespace around environments or use non-breaking spaces.

The backend implementation (`modules/ai-assist/app/src/LatexMatcher.mjs`) contains multi-tier matching:
- Tier 1: Exact string match.
- Tier 2: Normalized whitespace and line ending match.
- Tier 3: LaTeX token-aware match and unescaped backslash normalization (`\\` -> `\`).
- Tier 4: Scoped line-window search (`startLine` / `endLine`).

The frontend `edit-file.ts` implements only naive line trimming. When a model sends a double-escaped command, matching fails with `matches === 0` (`noMatch`).

**The Solution:**
1. Port the full multi-tier LaTeX matcher logic from `LatexMatcher.mjs` into frontend `edit-file.ts` / `use-project-handle.ts`.
2. When `noMatch` occurs, search for fuzzy candidate lines and return diagnostic hints:
   `"Could not find exact anchor. Nearest match was found at line 42: '\textbf{...}'. Did you mean to match this line?"`
3. Add `startLine` and `endLine` optional scoping parameters to `edit_file` tool schema to disambiguate repetitive LaTeX structures (table rows, list items, math environments).
4. Automatically sanitize `newText` by stripping leading line-number prefixes (e.g. `/^\s*\d+[:|]\s?/`).

---

## 4. Workstream Structure & Roadmap

```
+---------------------------------------------------------------------------------------------------+
| WS1: Editor Bridge & Path-Targeted Document Mutation                                              |
| - Target-aware readDocOverBridge(path) and applyEditOverBridge                                    |
| - Await CodeMirror doc switch & readiness event (ol-ai-assist-doc-ready)                          |
| - Fix create_file writing to line 1 of active tab; create parent directories recursively          |
| - Classify bridge timeout separately from document content drift                                  |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| WS2: Precision Anchor Resolution & Non-Destructive Code Replacement                               |
| - Character-offset and sub-line intra-line replacements                                           |
| - Fix append mode (oldText: "") in findUniqueSpan & apply-fix-listener                            |
| - Fix newline off-by-one in spanToLineRange; fix tier-3 blank line window corruption              |
| - Clean block deletion primitives without empty line artifacts                                    |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| WS3: Robust LaTeX Matching & Schema Ambiguity Resolution                                         |
| - Backend LaTeX tokenization and double-backslash unescaping in frontend                          |
| - Diagnostic error feedback with candidate line suggestions on noMatch/ambiguous                  |
| - Strip line-number prefixes (14: ...) from newText; eliminate contradictory full-file spec       |
| - Line-addressed search scoping (startLine / endLine)                                             |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| WS4: Compiler Feedback Loop, Delta Tracking & Log Diagnostic Enrichment                          |
| - Synchronize compile() in use-project-handle: await startCompile & handleLogFiles                |
| - Compute before/after error deltas (resolved, new, unchanged) with regression warnings           |
| - Separate root-cause vs cascading errors; enrich compile outcomes with raw TeX excerpts (l.<line>)|
| - Fix -file-line-error parser in LatexLogParser; register get_compile_log alias                   |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
| WS5: Context Indexing, Structural Search & Harness Hygiene                                        |
| - search_text glob pre-filtering & path parameter schema support                                  |
| - get_packages option retention & engine context; get_outline multi-file line bounding            |
| - Expose explicit file paths in initial project-context envelope                                  |
| - Resilient error recovery in runAgent; unique tool call IDs; CodeMirror bridge integration tests |
+---------------------------------------------------------------------------------------------------+
```

---

## 5. Rejected Designs & Architectural Non-Goals

During the architectural audit, ten potential approaches and hypotheses were rigorously evaluated and **rejected**. Implementers must not resurrect these designs.

### 5.1 Rejected: Pre-Write LaTeX Structural Validation (Brace/Environment Counting)
- **Hypothesis:** Intercept `edit_file` and `create_file` calls with a client-side parser to reject edits that result in unbalanced braces (`{}`) or unclosed LaTeX environments (`\begin{...}`).
- **Why Rejected (Refuted 3/3):** Static brace/environment counting produces unacceptable false-positive rejections. In real-world editing workflows, a model frequently fixes an unclosed brace by inserting a single closing brace `}`. In isolation, the snippet being inserted is unbalanced. Furthermore, LaTeX macros (e.g. `\newcommand{\foo}[1]{#1}`), verbatim environments (`\begin{verbatim}`), comment blocks (`% {`), and non-TeX files (BibTeX, `.sty`, `.cls`, `.txt`) do not obey simple bracket balance rules.
- **Decision:** The TeX compiler is the sole authoritative ground truth. Document validity must be verified via the synchronized compiler feedback loop (Workstream 4), not client-side heuristic filters.

### 5.2 Rejected: In-Tree Lezer-LaTeX Parser as a Pre-Write Validity Checker
- **Hypothesis:** Use CodeMirror's `@lezer/latex` syntax tree to check whether an edit introduces syntax error nodes before allowing it to apply.
- **Why Rejected (Refuted 3/3):** Lezer is a fault-tolerant syntax highlighter designed specifically to construct a parse tree even in the presence of severe syntax errors. Its `Tree.cursor().type.isError` flags do not correspond to TeX engine validity (e.g. TeX expansion errors, undefined control sequences, or missing package dependencies are invisible to Lezer). Attempting to use Lezer as a gatekeeper causes both false approvals and false rejections.
- **Decision:** Lezer remains exclusively a syntax highlighting and visual indentation grammar.

### 5.3 Rejected: Post-Apply Readback Verification in CodeMirror Bridge
- **Hypothesis:** After dispatching a transaction via `view.dispatch()`, perform an asynchronous readback of the document to verify that the edit was applied.
- **Why Rejected (Refuted 3/3):** CodeMirror 6's `view.dispatch()` is completely synchronous and atomic. Once `dispatch()` returns without throwing, the state transaction has been committed to `view.state.doc`. An immediate readback in the same tick is tautological and adds unnecessary latency.
- **Decision:** The bridge handshake confirms application synchronously upon `view.dispatch()` completion.

### 5.4 Rejected: Parallel-Tool-Call Drift Guarding
- **Hypothesis:** Parallel tool calls from frontier models cause anchor offsets to become stale, corrupting subsequent edits in the same turn.
- **Why Rejected (Refuted 2/3):** `proposeEdit` reads the live document state before computing anchor offsets. Additionally, the existing execution harness executes mutative tool calls sequentially. (Note: WS1 verifies path targeting during sequential execution).
- **Decision:** Enforce strict sequential execution for mutative tool calls (`mutates: true`).

### 5.5 Rejected: Module-Level `compileInFlight` Lock Redesign
- **Hypothesis:** The module-level variable `compileInFlight` in `compile-project.ts` risks permanently locking compilation across turns if an error occurs.
- **Why Rejected (Refuted 3/3):** In `compile-project.ts` (lines 25-45), `compileInFlight = true` is placed in a `try...finally` block where `compileInFlight = false` is guaranteed to execute by JavaScript runtime semantics.
- **Decision:** Retain the `try...finally` guard.

### 5.6 Rejected: Modifying Document Conventions via System Prompts
- **Hypothesis:** Add prompt rules instructing models to inspect document conventions (label styles, citation formats) before editing.
- **Why Rejected (Refuted 3/3):** Style conventions do not cause compilation failures. Tool failures must be resolved by engineering resilient tools, not by expanding prompt instructions.

### 5.7 Rejected: Index LaTeX Environment Nesting Stack
- **Hypothesis:** Maintain an AST environment nesting stack in `project-index.ts`.
- **Why Rejected (Refuted 2/3):** `project-index.ts` is designed for quick symbol discovery (packages, labels, macros). Models inspect document structure directly using `read_file` and `search_text`.

### 5.8 Rejected: Fenced Text Tool Call Parser Rewriting
- **Hypothesis:** The regex parser for markdown-fenced tool calls (` ```json `) drops unclosed JSON buffers.
- **Why Rejected (Refuted 3/3):** Stream completion flushes all pending buffers, and structured tool calling natively bypasses markdown text parsing.

### 5.9 Rejected: `EditApprovalCard` Structural Diff Warning Badges
- **Hypothesis:** Add visual warnings to the UI diff approval card when an edit appears to change brace balance.
- **Why Rejected (Refuted 3/3):** UI warnings do not fix model-generated code and create user confusion during valid single-brace fixes.

---

## 6. Global Constraints & Engineering Invariants

Every workstream and task must strictly conform to these engineering constraints:

1. **Harness & Tool Engineering Over System Prompts:**
   Fixes must be engineered into the TypeScript tools, CodeMirror bridge listeners, and log parsers. Never attempt to work around a broken tool by adding retry or guidance instructions to system prompts.
2. **Direct LLM Communication (No Backend Wrapper Endpoints):**
   No new Overleaf-side REST endpoints that wrap LLM provider APIs. AI requests communicate directly with the upstream provider from the client or background runner.
3. **No Instance-Wide Default Provider:**
   Users supply their own API keys and provider configurations via the UI.
4. **Weakest Model Parity:**
   All tools, anchor matchers, and error messages must function reliably with weak local models (e.g. Ollama models via native `/api/chat`). Do not assume frontier-model reasoning capabilities.
5. **Fail-Closed User Approval Diff Gate:**
   Every document modification must stay behind the user approval diff. No edit may be applied directly without confirmation.
6. **No Thrown Errors in Agent Loops:**
   Tools must never throw unhandled exceptions out of the agent loop. Every failure must return a structured JSON outcome with diagnostic feedback that the model can inspect.
7. **Feature Gating:**
   The AI Assist feature remains default-disabled and gated behind `getMeta('ol-aiAssistEnabled')`.
8. **Strict Git Safety:**
   Never run autonomous git write commands (`git commit`, `git push`, `git checkout`, `git stash`). Leave all changes uncommitted in the working tree.

---

## 7. Test Baselines & Execution Protocol

### 7.1 Verified Test Baselines
The test baselines on clean worktree state are verified as follows:

- **Frontend Unit & Component Suite (Mocha):**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend
  ```
  **Baseline:** **774 passing, 0 failing** (0 errors).

- **Backend Unit Suite (Vitest — NOT Mocha):**
  ```bash
  NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
  ```
  **Baseline:** **10 test files, 107 passing** (0 failing).

### 7.2 Critical Sandbox Traps
- **Trap 1 (Sandboxed Yarn):** The `yarn` binary fails inside the sandboxed subshell. Always invoke the test runners directly via `../../node_modules/.bin/mocha` and `../../node_modules/.bin/vitest`.
- **Trap 2 (Runner Distinction):** Backend tests use `vitest`; frontend tests use `mocha`. Running `mocha` on the backend test directory fails with `Cannot read properties of undefined (reading 'config')`.
- **Trap 3 (Pre-existing Failures):** The wider Overleaf web unit suite has ~57 pre-existing failures on clean main. Scope all test runs strictly to `modules/ai-assist/`.

---

## 8. Sequencing & Cross-Workstream Dependencies

The five implementation workstreams must be executed strictly in sequential order:

```
[WS1: Bridge Path Targeting] 
            │
            ▼
[WS2: Precision Anchor Apply]
            │
            ▼
[WS3: LaTeX Matcher Parity]
            │
            ▼
[WS4: Compiler Feedback Loop]
            │
            ▼
[WS5: Context & Search Hygiene]
```

### Sequencing Rationale:
1. **WS1 must land FIRST:** WS1 corrects the foundational document corruption defect where edits and file creations target the wrong open tab in CodeMirror. If WS1 is not in place, any improvements to matching or compilation will still corrupt `main.tex`.
2. **WS2 must land SECOND:** WS2 replaces line-granular slicing with character/offset resolution and fixes broken append mode. This provides the correct foundation for LaTeX replacements.
3. **WS3 must land THIRD:** WS3 integrates backend LaTeX tokenization and unescaping into the frontend matcher, adds candidate diagnostics, and sanitizes line numbers in `newText`.
4. **WS4 must land FOURTH:** WS4 fixes compile synchronization in `use-project-handle.ts`, unblocking accurate before/after compile delta evaluation and error attribution.
5. **WS5 must land FIFTH:** WS5 cleans up search indexing, package option retention, outline line bounding, and adds end-to-end bridge integration tests.

*Note for Implementers:* Because WS1 refactors `use-project-handle.ts` and `apply-fix-listener.tsx`, line numbers in WS2–WS5 plans will drift. Implementers must locate code by function signatures and verified code shapes rather than rigid line numbers.

---

## 9. File Structure & Modification Inventory

The table below catalogs every source file modified or introduced across the five workstreams:

| File Path | Primary Workstream | Scope of Modifications |
|---|---|---|
| `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts` | WS1, WS2, WS4, WS5 | Path-targeted bridge read/write; offset-aware line mapping; compile synchronization; search glob pre-filtering; folder creation. |
| `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx` | WS1, WS2 | Path-aware event listener; sub-line character offset replacement; append mode handling; timeout vs drift status. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts` | WS2, WS3 | Backend LaTeX tokenization parity; double-backslash unescaping; candidate line diagnostics; line-number prefix sanitization; `startLine`/`endLine` schema. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/create-file.ts` | WS1 | Remove bridge write from line 1 of active tab; pass initial content directly to backend entity initialization. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-project.ts` | WS4 | Regression delta calculation (`errorDelta`, `newErrors`); raw TeX excerpt inclusion (`l.<line>`); update tool description. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/context/compile-error.ts` | WS4 | Primary root-cause vs downstream cascade error classification; context line inclusion. |
| `modules/ai-assist/app/src/LatexLogParser.mjs` | WS4 | Fix `-file-line-error` line number attribution and error extraction. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts` | WS3 | Clarify numbered output formatting; integrate with `edit_file` prefix sanitizer. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/fix-run.ts` | WS3 | Prevent line-number contamination from `renderSourceWindow` into suggested edits. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/search-text.ts` | WS5 | Add `path` parameter to JSON schema; apply 50-hit limit per-file after glob filtering. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-index.ts` | WS5 | Retain package options (`[utf8]`) in `get_packages`; capture engine context. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-outline.ts` | WS5 | Bound section line ranges strictly within the declaring file boundary. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-context.ts` | WS5 | Expose explicit file path list for small/medium projects. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts` | WS5 | Resilient recovery on anchor mismatch; unique tool call ID generator (`crypto.randomUUID` or incremental counter). |
| `modules/ai-assist/test/frontend/js/agent/helpers/fake-handle.ts` | WS5 | Add bridge simulation and path-targeted file creation testing helpers. |
| `modules/ai-assist/test/frontend/js/agent/bridge-integration.test.ts` | WS1, WS5 | *New Test File:* End-to-end integration tests for CodeMirror bridge document switching and edit dispatch. |
