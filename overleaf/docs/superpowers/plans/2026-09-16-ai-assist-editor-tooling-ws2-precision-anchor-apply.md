# AI Assist Editor Tooling & Harness Redesign: Workstream 2 — Precision Anchor Resolution & Non-Destructive Code Replacement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate destructive whole-line overwrites and drift rejections by transitioning the editor bridge and project handle from coarse whole-line replacements to exact character-offset spans; fix broken append mode (`oldText: ""`); correct boundary newline calculation in `spanToLineRange`; resolve `findUniqueSpan` Tier 3 window corruption on blank lines; and ensure clean line deletions without residual blank lines.

**Architecture:** 
1. `use-project-handle.ts` provides exact character spans (`fromOffset`, `toOffset`, `matchedLength`) alongside line ranges (`startLine`, `endLine`) and detects append mode (`isAppend: true`, `oldText === ""`).
2. `spanToLineRange` accounts for boundary trailing newlines so that trailing `\n` on multi-line or single-line anchors does not advance the line range into the next line.
3. `findUniqueSpan` preserves intermediate blank lines in Tier 3 (symmetric line trimming) and returns the true character length of the matched span (`matchedLength`), preventing window shifts and drift mismatches.
4. `applyEditOverBridge` transmits `{ path, from, to, fromOffset, toOffset, oldText, replacement, isAppend }` across the window event boundary.
5. `apply-fix-listener.tsx` implements a 4-tier application strategy:
   - **Append Mode:** If `isAppend === true` or `oldText === ""`, bypasses drift checks, computes insertion offset at `view.state.doc.length`, formats prepended newline if needed, dispatches insertion, and returns `applied`.
   - **Character Offset Replacement:** If `fromOffset` and `toOffset` are provided and match `oldText` at `view.state.sliceDoc(fromOffset, toOffset)`, applies exact intra-line slice replacement.
   - **In-Doc Search Fallback:** If character offsets drifted, searches for `oldText` uniquely in the live `view.state.doc`.
   - **Clean Line Deletion:** If `replacement === ""` and deleting full lines, extends the deletion span to consume the trailing newline (or leading newline at EOF) to prevent residual blank lines.

**Tech Stack:** TypeScript, React, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/search`), Mocha + Chai + Sinon + @testing-library/react (frontend tests).

**Spec:** `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/docs/superpowers/specs/2026-09-16-ai-assist-editor-tooling-redesign-design.md`

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
- **Backend test runner** (vitest, for full suite verification):
  ```bash
  NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
  ```
- **Sandbox execution:** Invoke test binaries directly via `../../node_modules/.bin/mocha` from `services/web`. Do not use bare `yarn test` in the sandbox.
- **Fail-Closed Safety:** Every edit must remain behind user approval diff review. No edits may be applied directly without user confirmation.
- **No Provider Wrappers or Hardcoded Prompts:** Fixes must be engineered into the tools and harness directly. Never attempt to fix tool behavior by modifying system prompts or adding workaround instructions to prompts.
- **Baseline (verified green):** Frontend Mocha: 774 passing; Backend Vitest: 10 test files, 107 passing. Scope runs to `modules/ai-assist/` to avoid pre-existing main repository test failures.

---

## Cross-Workstream Dependency & Drift Note

> **CRITICAL PRE-REQUISITE:**
> Workstream 1 (WS1: *Editor Bridge & Path-Targeted Document Mutation*) refactors document reading and path-scoped dispatch in `use-project-handle.ts` and `apply-fix-listener.tsx`.
> 
> When implementing Workstream 2 (WS2), line numbers in `use-project-handle.ts` and `apply-fix-listener.tsx` may have drifted. **Locate functions by their signatures and quoted code shapes, never by raw line indices.**
> 
> WS2 builds upon WS1 by upgrading the payload transmitted across the bridge from coarse line ranges to precision character offsets and adding append/deletion primitives.

---

## File Structure & Modification Inventory

| File | Nature of Change | Purpose |
|---|---|---|
| `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts` | Modify | Fix `spanToLineRange` boundary newline handling; fix `findUniqueSpan` Tier 3 blank line matching & return `matchedLength`; update `proposeEdit` and `applyEditOverBridge` to pass character offsets and `isAppend`. |
| `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx` | Modify | Implement precision character offset replacement; implement non-destructive append mode; implement clean line deletion without residual blank lines; preserve backward compatibility for line ranges. |
| `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts` | Modify | Add comprehensive tests for `spanToLineRange` newline boundary calculation, `findUniqueSpan` Tier 3 blank line matching, and `matchedLength` tracking. |
| `modules/ai-assist/test/frontend/js/agent/apply-fix-listener.test.tsx` | Create | New test suite verifying `ApplyFixListener` event handling for append mode, intra-line word replacements, clean line deletions, and drift detection. |

---

## Detailed Root Cause Analysis of Defect 2

### 1. The Append Mode (`oldText: ""`) Failure Trace
When an agent or tool attempts to append content to the end of a document (e.g. adding a bibliography or package), the following execution trace occurs:
1. `edit_file` tool receives `{ path: 'main.tex', oldText: '', newText: '\\bibliography{refs}' }` and calls `handle.proposeEdit({ path, oldText: '', newText })`.
2. In `use-project-handle.ts` (lines 38-41), `findUniqueSpan(content, '')` returns `{ status: 'found', index: content.length }`.
3. In `use-project-handle.ts` (line 508), `spanToLineRange(content, content.length, 0)` computes:
   - `from = content.slice(0, content.length).split('\n').length` (which equals `doc.lines`, the final line number $N$).
   - `to = content.slice(0, content.length).split('\n').length` (which equals $N$).
4. In `use-project-handle.ts` (line 523), `applyEditOverBridge` sends `{ from: N, to: N, oldText: '', replacement: newText }`.
5. In `apply-fix-listener.tsx` (lines 98-102), the bridge listener executes:
   ```ts
   const current = view.state.doc.toString().split('\n')
   if (current.slice(from - 1, to).join('\n') !== oldText) {
     return respond('drifted')
   }
   ```
   Here `current.slice(N - 1, N).join('\n')` extracts the entire text of the last line of the document (e.g. `\end{document}`).
   It evaluates `"\end{document}" !== ""`, which is **TRUE**.
6. The listener immediately responds with `{ status: 'drifted' }`.
7. Every append operation in the assistant is systematically rejected as `drifted`, making file appends impossible.

### 2. Sub-Line / Intra-Line Overwrite & Drift Clashing
When an agent attempts a surgical intra-line edit (such as replacing `\cite{old}` with `\cite{new}` within a sentence):
1. `findUniqueSpan` finds the character offset of `\cite{old}`.
2. `spanToLineRange` converts this character offset into whole-line numbers `from = L, to = L`.
3. `apply-fix-listener.tsx` tests `current.slice(L - 1, L).join('\n') !== oldText`. The current line contains the entire paragraph `In this paper, we cite \cite{old} extensively.`.
4. Comparing the entire paragraph against `\cite{old}` returns false, rejecting the edit as `drifted`.
5. If the drift check were bypassed, `lineRangeToOffsets` would replace from column 0 of line $L$ to the end of line $L$, completely wiping out `In this paper, we cite ` and ` extensively.`.

### 3. `spanToLineRange` Off-By-One with Boundary Newlines
In `use-project-handle.ts`:
```ts
export function spanToLineRange(
  text: string,
  index: number,
  length: number
): { from: number; to: number } {
  const from = text.slice(0, index).split('\n').length
  const to = text.slice(0, index + length).split('\n').length
  return { from, to }
}
```
If `text` is `"alpha\nbeta\ngamma\n"` and `oldText` is `"beta\n"` (`index = 6`, `length = 5`):
- `text.slice(0, 6)` is `"alpha\n"` -> `from = 2` (line 2, `beta`).
- `text.slice(0, 6 + 5)` is `"alpha\nbeta\n"`.
- `"alpha\nbeta\n".split('\n')` produces `['alpha', 'beta', '']` with length 3.
- `to` becomes `3` (line 3, `gamma`), even though `beta\n` is contained entirely on line 2!
- The applier replaces lines 2 through 3, deleting the unrelated line `gamma`.

### 4. `findUniqueSpan` Tier 3 Blank Line Window Corruption
In `use-project-handle.ts` (lines 90-113):
```ts
const textLines = text.split('\n')
const oldLines = oldText.split('\n').map(l => l.trim()).filter(Boolean)
```
When `oldText` contains multi-line LaTeX with blank lines (e.g. paragraphs separated by `\n\n`):
- `.filter(Boolean)` removes all empty strings from `oldLines`.
- `textLines` retains all blank lines.
- The loop compares `textLines[i + j].trim() !== oldLines[j]`. As soon as it encounters a blank line in `textLines`, `textLines[i + j].trim()` is `""`, but `oldLines[j]` is the next non-blank line of `oldText`.
- The comparison fails, causing valid multi-line anchors to return `noMatch`.

### 5. Residual Blank Lines on Block Deletions
When an edit deletes a line (i.e. `replacement === ""`), line-based replacements delete from `line.from` to `line.to`. This removes the text content but leaves the newline character `\n` intact, leaving an empty line behind. In LaTeX environments like `\begin{align} ... \end{align}`, blank lines are syntax errors (`Paragraph ended before \align was complete`).

---

## Tasks

### Task 1: Correct `spanToLineRange` Newline Boundary Arithmetic & `findUniqueSpan` Tier 3 Blank Line Matching

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Modify: `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts`

**Interfaces:**
- `export function spanToLineRange(text: string, index: number, length: number): { from: number; to: number }`
- `export function findUniqueSpan(text: string, oldText: string): { status: 'found'; index: number; matchedLength: number } | { status: 'ambiguous'; matches: number } | { status: 'noMatch' }`

- [ ] **Step 1: Write the failing tests and update existing test in `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts`**

Update `editor-bridge.test.ts` to:
1. Update existing test `it('returns the index of a single occurrence')` (lines 14-19) to expect `matchedLength: 5` alongside `index: 11` (since `findUniqueSpan` now returns `matchedLength`).
2. Add test cases verifying:
   - `spanToLineRange` when `oldText` ends in a newline does NOT increment `to` to the next line.
   - `spanToLineRange` for multi-line blocks with trailing newlines.
   - `findUniqueSpan` returns `matchedLength` on exact, whitespace-trimmed, and Tier-3 matches.
   - `findUniqueSpan` Tier 3 matches blocks containing blank lines accurately without window corruption.
   - `findUniqueSpan` with empty `oldText` returns `{ status: 'found', index: text.length, matchedLength: 0 }`.

Update `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts`:

```ts
  // Update pre-existing test (lines 14-19):
  it('returns the index of a single occurrence', function () {
    expect(findUniqueSpan(TEXT, 'gamma')).to.deep.equal({
      status: 'found',
      index: 11,
      matchedLength: 5,
    })
  })

  // Add new tests:
  it('returns matchedLength alongside index for exact matches', function () {
    expect(findUniqueSpan(TEXT, 'gamma')).to.deep.equal({
      status: 'found',
      index: 11,
      matchedLength: 5,
    })
  })

  it('matches multi-line blocks containing blank lines in Tier 3', function () {
    const docWithBlanks = 'line 1\n\nline 2\nline 3\n'
    const needleWithBlanks = '  line 1  \n\n  line 2  '
    const result = findUniqueSpan(docWithBlanks, needleWithBlanks)
    expect(result.status).to.equal('found')
    if (result.status === 'found') {
      expect(result.index).to.equal(0)
      expect(result.matchedLength).to.equal('line 1\n\nline 2'.length)
    }
  })

  it('handles empty oldText for append mode', function () {
    expect(findUniqueSpan(TEXT, '')).to.deep.equal({
      status: 'found',
      index: TEXT.length,
      matchedLength: 0,
    })
  })

  it('does not advance to line when span ends with a newline', function () {
    // TEXT = 'alpha\nbeta\ngamma\nbeta\n'
    // 'beta\n' at index 6 has length 5 (indices 6..10). It occupies line 2 only.
    const index = TEXT.indexOf('beta\n')
    expect(spanToLineRange(TEXT, index, 'beta\n'.length)).to.deep.equal({
      from: 2,
      to: 2,
    })
  })

  it('calculates accurate line ranges for multi-line anchors ending with newline', function () {
    // 'beta\ngamma\n' starts at line 2 and ends at line 3.
    const index = TEXT.indexOf('beta\ngamma\n')
    expect(spanToLineRange(TEXT, index, 'beta\ngamma\n'.length)).to.deep.equal({
      from: 2,
      to: 3,
    })
  })
```

Run mocha test to confirm failure:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts
```

- [ ] **Step 2: Update `findUniqueSpan` and `spanToLineRange` in `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`**

Find existing functions at lines 37-126:

**Exact current code:**
```ts
export function findUniqueSpan(text: string, oldText: string) {
  // Append mode: empty oldText matches the very end of the file
  if (!oldText) {
    return { status: 'found' as const, index: text.length }
  }

  // 1. Exact match
  const first = text.indexOf(oldText)
  if (first !== -1) {
    let matches = 0
    let index = first
    while (index !== -1) {
      matches += 1
      index = text.indexOf(oldText, index + oldText.length)
    }
    if (matches > 1) return { status: 'ambiguous' as const, matches }
    return { status: 'found' as const, index: first }
  }

  // 2. Trailing whitespace-normalized match
  const normText = text
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  const normOld = oldText
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  const normFirst = normText.indexOf(normOld)
  if (normFirst !== -1) {
    let matches = 0
    let index = normFirst
    while (index !== -1) {
      matches += 1
      index = normText.indexOf(normOld, index + normOld.length)
    }
    if (matches > 1) return { status: 'ambiguous' as const, matches }

    const lineNum = normText.slice(0, normFirst).split('\n').length - 1
    const origLines = text.split('\n')
    let origIndex = 0
    for (let i = 0; i < lineNum; i++) {
      origIndex += origLines[i].length + 1
    }
    const lineOffset =
      normFirst -
      normText.split('\n').slice(0, lineNum).join('\n').length -
      (lineNum > 0 ? 1 : 0)
    origIndex += Math.max(0, lineOffset)
    return { status: 'found' as const, index: origIndex }
  }

  // 3. Line-by-line trimmed match
  const textLines = text.split('\n')
  const oldLines = oldText.split('\n').map(l => l.trim()).filter(Boolean)
  if (oldLines.length > 0) {
    const matchingStarts: number[] = []
    for (let i = 0; i <= textLines.length - oldLines.length; i++) {
      let matches = true
      for (let j = 0; j < oldLines.length; j++) {
        if (textLines[i + j].trim() !== oldLines[j]) {
          matches = false
          break
        }
      }
      if (matches) matchingStarts.push(i)
    }
    if (matchingStarts.length === 1) {
      const lineIdx = matchingStarts[0]
      const charIndex =
        textLines.slice(0, lineIdx).join('\n').length + (lineIdx > 0 ? 1 : 0)
      return { status: 'found' as const, index: charIndex }
    }
    if (matchingStarts.length > 1) {
      return { status: 'ambiguous' as const, matches: matchingStarts.length }
    }
  }

  return { status: 'noMatch' as const }
}

export function spanToLineRange(
  text: string,
  index: number,
  length: number
): { from: number; to: number } {
  const from = text.slice(0, index).split('\n').length
  const to = text.slice(0, index + length).split('\n').length
  return { from, to }
}
```

**Replace with exact new code:**
```ts
export type UniqueSpanResult =
  | { status: 'found'; index: number; matchedLength: number }
  | { status: 'ambiguous'; matches: number }
  | { status: 'noMatch' }

export function findUniqueSpan(text: string, oldText: string): UniqueSpanResult {
  // Append mode: empty oldText matches the very end of the file
  if (!oldText) {
    return { status: 'found', index: text.length, matchedLength: 0 }
  }

  // 1. Exact match
  const first = text.indexOf(oldText)
  if (first !== -1) {
    let matches = 0
    let index = first
    while (index !== -1) {
      matches += 1
      index = text.indexOf(oldText, index + oldText.length)
    }
    if (matches > 1) return { status: 'ambiguous', matches }
    return { status: 'found', index: first, matchedLength: oldText.length }
  }

  // 2. Trailing whitespace-normalized match
  const normText = text
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  const normOld = oldText
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  const normFirst = normText.indexOf(normOld)
  if (normFirst !== -1) {
    let matches = 0
    let index = normFirst
    while (index !== -1) {
      matches += 1
      index = normText.indexOf(normOld, index + normOld.length)
    }
    if (matches > 1) return { status: 'ambiguous', matches }

    const lineNum = normText.slice(0, normFirst).split('\n').length - 1
    const origLines = text.split('\n')
    let origIndex = 0
    for (let i = 0; i < lineNum; i++) {
      origIndex += origLines[i].length + 1
    }
    const lineOffset =
      normFirst -
      normText.split('\n').slice(0, lineNum).join('\n').length -
      (lineNum > 0 ? 1 : 0)
    origIndex += Math.max(0, lineOffset)

    const oldLines = oldText.split('\n')
    const oldLineCount = oldLines.length
    let matchedLength: number
    if (oldLineCount === 1) {
      matchedLength = Math.min(
        oldText.length,
        origLines[lineNum].length - lineOffset
      )
    } else {
      let len = origLines[lineNum].length - lineOffset + 1
      for (let i = 1; i < oldLineCount - 1; i++) {
        len += origLines[lineNum + i].length + 1
      }
      len += Math.min(
        origLines[lineNum + oldLineCount - 1].length,
        oldLines[oldLineCount - 1].length
      )
      matchedLength = len
    }

    return {
      status: 'found',
      index: origIndex,
      matchedLength: Math.max(0, matchedLength),
    }
  }

  // 3. Line-by-line trimmed match (preserving blank lines for 1:1 alignment)
  const textLines = text.split('\n')
  const oldLines = oldText.split('\n').map(l => l.trim())
  if (oldLines.length > 0 && oldLines.some(l => l.length > 0)) {
    const matchingStarts: number[] = []
    for (let i = 0; i <= textLines.length - oldLines.length; i++) {
      let matches = true
      for (let j = 0; j < oldLines.length; j++) {
        if (textLines[i + j].trim() !== oldLines[j]) {
          matches = false
          break
        }
      }
      if (matches) matchingStarts.push(i)
    }
    if (matchingStarts.length === 1) {
      const lineIdx = matchingStarts[0]
      let charIndex = 0
      for (let i = 0; i < lineIdx; i++) {
        charIndex += textLines[i].length + 1
      }
      const matchedLines = textLines.slice(lineIdx, lineIdx + oldLines.length)
      const matchedLength = matchedLines.join('\n').length
      return { status: 'found', index: charIndex, matchedLength }
    }
    if (matchingStarts.length > 1) {
      return { status: 'ambiguous', matches: matchingStarts.length }
    }
  }

  return { status: 'noMatch' }
}

export function spanToLineRange(
  text: string,
  index: number,
  length: number
): { from: number; to: number } {
  const from = text.slice(0, index).split('\n').length
  const effectiveEnd =
    length > 0 && text[index + length - 1] === '\n'
      ? index + length - 1
      : index + length
  const to = text.slice(0, effectiveEnd).split('\n').length
  return { from, to: Math.max(from, to) }
}
```

- [ ] **Step 3: Run the test to verify passing**
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts
```
Expected: All tests passing.

---

### Task 2: Character-Offset Bridge Protocol in `use-project-handle.ts`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`

**Interfaces:**
- `applyEditOverBridge` detail payload:
  ```ts
  detail: {
    path?: string
    from?: number
    to?: number
    fromOffset?: number
    toOffset?: number
    oldText: string
    replacement: string
    isAppend?: boolean
  }
  ```

- [ ] **Step 1: Update `applyEditOverBridge` and `proposeEdit` in `use-project-handle.ts`**

**Locate `applyEditOverBridge` (around line 226):**
```ts
function applyEditOverBridge(
  detail: { from: number; to: number; oldText: string; replacement: string },
  timeoutMs = REPLY_TIMEOUT_MS
): Promise<{ status: string }> {
```

**Replace with:**
```ts
export type BridgeEditDetail = {
  path?: string
  from?: number
  to?: number
  fromOffset?: number
  toOffset?: number
  oldText: string
  replacement: string
  isAppend?: boolean
}

function applyEditOverBridge(
  detail: BridgeEditDetail,
  timeoutMs = REPLY_TIMEOUT_MS
): Promise<{ status: string }> {
  return new Promise(resolve => {
    let resolved = false
    let timer: any
    const onResult = (event: Event) => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
      if (timer) clearTimeout(timer)
      resolve((event as CustomEvent)?.detail ?? { status: 'drifted' })
    }
    window.addEventListener('aiAssist:agentApplyEditResult', onResult)
    timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
      resolve({ status: 'timeout' })
    }, timeoutMs)
    window.dispatchEvent(new CustomEvent('aiAssist:agentApplyEdit', { detail }))
  })
}
```

**Locate `proposeEdit` (around lines 485-535):**
```ts
      const span = findUniqueSpan(content, edit.oldText)
      if (span.status !== 'found') {
        return span
      }

      const { from: startLine } = spanToLineRange(content, span.index, edit.oldText.length)

      const approval = await requestApproval(edit, { startLine })
      if (!approval.accepted) {
        return { status: 'rejected', note: approval.note }
      }

      if (fileTreeData && openDocWithId) {
        const entity = findEntityByPath(fileTreeData, edit.path)
        if (entity?.type === 'doc') {
          openDocWithId(entity.entity._id)
        }
      }

      const { to: endLine } = spanToLineRange(content, span.index + edit.oldText.length, 0)
      const applied = await applyEditOverBridge({
        from: startLine,
        to: endLine,
        oldText: edit.oldText,
        replacement: edit.newText,
      })

      return applied?.status === 'applied'
        ? { status: 'applied', startLine }
        : { status: 'drifted' }
```

**Replace with:**
```ts
      const span = findUniqueSpan(content, edit.oldText)
      if (span.status !== 'found') {
        return span
      }

      const matchedLen = span.matchedLength ?? edit.oldText.length
      const { from: startLine, to: endLine } = spanToLineRange(
        content,
        span.index,
        matchedLen
      )

      const approval = await requestApproval(edit, { startLine })
      if (!approval.accepted) {
        return { status: 'rejected', note: approval.note }
      }

      if (fileTreeData && openDocWithId) {
        const entity = findEntityByPath(fileTreeData, edit.path)
        if (entity?.type === 'doc') {
          openDocWithId(entity.entity._id)
        }
      }

      const isAppend = edit.oldText === ''
      const fromOffset = span.index
      const toOffset = span.index + matchedLen

      const applied = await applyEditOverBridge({
        path: edit.path,
        from: startLine,
        to: endLine,
        fromOffset,
        toOffset,
        oldText: edit.oldText,
        replacement: edit.newText,
        isAppend,
      })

      return applied?.status === 'applied'
        ? { status: 'applied', startLine }
        : { status: 'drifted' }
```

- [ ] **Step 2: Verify `editor-bridge.test.ts` and `edit-tool.test.ts` continue to pass**
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts
```

---

### Task 3: Non-Destructive Sub-Line Character Replacement, Append Mode, and Clean Block Deletions in `apply-fix-listener.tsx`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx`

**Interfaces:**
- Event: `aiAssist:agentApplyEdit` with `CustomEvent<BridgeEditDetail>`
- Event Result: `aiAssist:agentApplyEditResult` with `{ detail: { status: 'applied' | 'drifted' | 'pathMismatch' } }`

- [ ] **Step 1: Update `apply-fix-listener.tsx`**

**Current `apply-fix-listener.tsx` implementation (lines 87-113):**
```ts
  const onAgentApplyEdit = useCallback(
    (event: Event) => {
      const { from, to, oldText, replacement } =
        (event as CustomEvent<any>).detail ?? {}

      const current = view.state.doc.toString().split('\n')
      const respond = (status: string) =>
        window.dispatchEvent(
          new CustomEvent('aiAssist:agentApplyEditResult', { detail: { status } })
        )

      // The user may have typed since the diff was rendered. Compare against the
      // anchor the model matched, not a stale snapshot.
      if (current.slice(from - 1, to).join('\n') !== oldText) {
        return respond('drifted')
      }

      const offsets = lineRangeToOffsets(view.state.doc, from, to)
      if (!offsets) return respond('drifted')

      view.dispatch({
        changes: { from: offsets.from, to: offsets.to, insert: replacement },
      })
      respond('applied')
    },
    [view]
  )
```

**Replace with the robust 4-tier character-offset and append applier:**
```tsx
import { useCallback, useEffect } from 'react'
import { useCodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import useEventListener from '@/shared/hooks/use-event-listener'
import getMeta from '@/utils/meta'
import { findUniqueSpan } from '../agent/use-project-handle'

function lineRangeToOffsets(
  doc: { lines: number; line: (n: number) => { from: number; to: number } },
  from: number,
  to: number
): { from: number; to: number } | null {
  if (from < 1 || to > doc.lines || from > to) return null
  return {
    from: doc.line(from).from,
    to: doc.line(to).to,
  }
}

function ApplyFixListenerInner() {
  const view = useCodeMirrorViewContext()
  const { openDocName } = useEditorOpenDocContext()

  useEffect(() => {
    const handleSelectionChange = () => {
      const active = document.activeElement
      // If focus is in an input or textarea outside the CodeMirror editor view, ignore
      if (active && !view.dom.contains(active) && active !== document.body) {
        return
      }
      const { from, to } = view.state.selection.main
      if (from !== to) {
        const startLine = view.state.doc.lineAt(from).number
        const endLine = view.state.doc.lineAt(to).number
        const text = view.state.sliceDoc(from, to)
        const path = openDocName || 'main.tex'
        window.dispatchEvent(
          new CustomEvent('aiAssist:selectionChanged', {
            detail: { path, from: startLine, to: endLine, text },
          })
        )
      } else {
        window.dispatchEvent(
          new CustomEvent('aiAssist:selectionChanged', {
            detail: null,
          })
        )
      }
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentCursor', {
          detail: { line: view.state.doc.lineAt(view.state.selection.main.head).number },
        })
      )
    }

    // Seed it once: until the user clicks or types in the editor, the agent's
    // context would carry no cursor line at all, and a first message sent
    // straight from the rail would have nothing to say where the user is.
    handleSelectionChange()

    const dom = view.dom
    dom.addEventListener('mouseup', handleSelectionChange)
    dom.addEventListener('keyup', handleSelectionChange)
    dom.addEventListener('pointerup', handleSelectionChange)
    document.addEventListener('selectionchange', handleSelectionChange)

    return () => {
      dom.removeEventListener('mouseup', handleSelectionChange)
      dom.removeEventListener('keyup', handleSelectionChange)
      dom.removeEventListener('pointerup', handleSelectionChange)
      document.removeEventListener('selectionchange', handleSelectionChange)
      window.dispatchEvent(
        new CustomEvent('aiAssist:selectionChanged', {
          detail: null,
        })
      )
    }
  }, [view, openDocName])

  const onAgentReadDoc = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('aiAssist:agentReadDocResult', {
        detail: { text: view.state.doc.toString() },
      })
    )
  }, [view])

  const onAgentApplyEdit = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<any>).detail ?? {}
      const {
        from,
        to,
        fromOffset,
        toOffset,
        oldText,
        replacement = '',
        isAppend,
        path,
      } = detail

      const respond = (status: string) =>
        window.dispatchEvent(
          new CustomEvent('aiAssist:agentApplyEditResult', { detail: { status } })
        )

      // Path matching guard: if path was passed and does not match current open doc
      if (
        path &&
        openDocName &&
        path.replace(/^\//, '') !== openDocName.replace(/^\//, '')
      ) {
        return respond('pathMismatch')
      }

      const doc = view.state.doc
      const docText = doc.toString()

      // 1. Append mode: when oldText is empty or isAppend is true
      if (isAppend || oldText === '') {
        const docLen = doc.length
        let insertText = replacement
        // If the document is non-empty and does not end with a newline, prepend one
        if (docLen > 0 && !docText.endsWith('\n')) {
          insertText = '\n' + replacement
        }
        view.dispatch({
          changes: { from: docLen, to: docLen, insert: insertText },
        })
        return respond('applied')
      }

      // Helper to compute clean line deletion offsets
      const adjustForCleanLineDeletion = (cFrom: number, cTo: number) => {
        if (replacement !== '') return { cFrom, cTo }
        const isFullLineStart = cFrom === 0 || docText[cFrom - 1] === '\n'
        const isFullLineEnd =
          cTo === doc.length || docText[cTo - 1] === '\n' || docText[cTo] === '\n'
        if (isFullLineStart && isFullLineEnd) {
          // If the span already includes its trailing newline, no adjustment is needed
          if (cTo > cFrom && docText[cTo - 1] === '\n') {
            return { cFrom, cTo }
          }
          if (cTo < doc.length && docText[cTo] === '\n') {
            return { cFrom, cTo: cTo + 1 }
          } else if (cFrom > 0 && docText[cFrom - 1] === '\n') {
            return { cFrom: cFrom - 1, cTo }
          }
        }
        return { cFrom, cTo }
      }

      // 2. Character-offset resolution (Primary precision path)
      if (typeof fromOffset === 'number' && typeof toOffset === 'number') {
        if (
          fromOffset >= 0 &&
          toOffset <= doc.length &&
          fromOffset <= toOffset
        ) {
          const slice = view.state.sliceDoc(fromOffset, toOffset)
          const normSlice = slice
            .split('\n')
            .map(l => l.trimEnd())
            .join('\n')
          const normOldText = oldText
            .split('\n')
            .map(l => l.trimEnd())
            .join('\n')
          if (
            slice === oldText ||
            slice.trimEnd() === oldText.trimEnd() ||
            slice.trim() === oldText.trim() ||
            normSlice === normOldText
          ) {
            const { cFrom, cTo } = adjustForCleanLineDeletion(
              fromOffset,
              toOffset
            )
            view.dispatch({
              changes: { from: cFrom, to: cTo, insert: replacement },
            })
            return respond('applied')
          }
        }
      }

      // 3. Fallback: Search for oldText in live document (handles cursor/typing drift)
      if (typeof oldText === 'string' && oldText.length > 0) {
        const span = findUniqueSpan(docText, oldText)
        if (span.status === 'found') {
          const cFrom = span.index
          const cTo = span.index + (span.matchedLength ?? oldText.length)
          const { cFrom: adjFrom, cTo: adjTo } = adjustForCleanLineDeletion(
            cFrom,
            cTo
          )
          view.dispatch({
            changes: { from: adjFrom, to: adjTo, insert: replacement },
          })
          return respond('applied')
        } else if (span.status === 'ambiguous') {
          return respond('drifted')
        }
      }

      // 4. Fallback: Line-range resolution (Legacy support)
      if (typeof from === 'number' && typeof to === 'number') {
        const offsets = lineRangeToOffsets(doc, from, to)
        if (!offsets) return respond('drifted')

        const currentSlice = view.state.sliceDoc(offsets.from, offsets.to)
        if (
          currentSlice === oldText ||
          currentSlice.split('\n').map(l => l.trimEnd()).join('\n') ===
            oldText.split('\n').map(l => l.trimEnd()).join('\n')
        ) {
          const { cFrom, cTo } = adjustForCleanLineDeletion(
            offsets.from,
            offsets.to
          )
          view.dispatch({
            changes: { from: cFrom, to: cTo, insert: replacement },
          })
          return respond('applied')
        }
      }

      respond('drifted')
    },
    [view, openDocName]
  )

  const onAgentReadSelection = useCallback(() => {
    const { from, to } = view.state.selection.main
    window.dispatchEvent(
      new CustomEvent('aiAssist:agentSelection', {
        detail:
          from === to
            ? null
            : {
                path: openDocName || 'main.tex',
                from: view.state.doc.lineAt(from).number,
                to: view.state.doc.lineAt(to).number,
                text: view.state.sliceDoc(from, to),
              },
      })
    )
  }, [view, openDocName])

  const onJumpToLine = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<{ line?: number; column?: number }>).detail
      if (typeof detail?.line === 'number' && view) {
        const lineNo = Math.min(Math.max(1, detail.line), view.state.doc.lines)
        const line = view.state.doc.line(lineNo)
        const col = typeof detail.column === 'number' ? Math.max(0, detail.column - 1) : 0
        const pos = Math.min(line.from + col, line.to)
        view.dispatch({
          selection: { anchor: pos, head: pos },
          scrollIntoView: true,
        })
      }
    },
    [view]
  )

  const onInsertSnippet = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; command?: string }>).detail
      const text = detail?.text ?? detail?.command
      if (typeof text !== 'string' || !view) return

      view.focus()
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length, head: from + text.length },
        scrollIntoView: true,
      })
    },
    [view]
  )

  useEventListener('aiAssist:agentReadDoc', onAgentReadDoc)
  useEventListener('aiAssist:agentApplyEdit', onAgentApplyEdit)
  useEventListener('aiAssist:agentReadSelection', onAgentReadSelection)
  useEventListener('aiAssist:jumpToLine', onJumpToLine)
  useEventListener('aiAssist:insertSnippet', onInsertSnippet)

  return null
}

/**
 * Bridges agent edits and editor state to the document.
 */
export default function ApplyFixListener() {
  const isEnabled =
    Boolean(getMeta('ol-aiAssistEnabled')) &&
    getMeta('ol-showAiFeatures') !== false

  if (!isEnabled) {
    return null
  }

  return <ApplyFixListenerInner />
}
```

---

### Task 4: Unit Test Suite for `ApplyFixListener` (`apply-fix-listener.test.tsx`)

**Files:**
- Create: `modules/ai-assist/test/frontend/js/agent/apply-fix-listener.test.tsx`

**Interfaces:**
- Tests the complete event lifecycle of `ApplyFixListener` in CodeMirror 6 context.

- [ ] **Step 1: Write `modules/ai-assist/test/frontend/js/agent/apply-fix-listener.test.tsx`**

Create `modules/ai-assist/test/frontend/js/agent/apply-fix-listener.test.tsx`:

```tsx
import { expect } from 'chai'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { CodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { EditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import ApplyFixListener from '../../../../frontend/js/features/ai-assist/components/apply-fix-listener'
import { resetMeta } from '../../../../../../test/frontend/helpers/reset-meta'

describe('ApplyFixListener', function () {
  let container: HTMLDivElement
  let view: EditorView

  function setupEditor(docText: string, openDocName = 'main.tex') {
    cleanup()
    container = document.createElement('div')
    document.body.appendChild(container)

    const state = EditorState.create({ doc: docText })
    view = new EditorView({ state, parent: container })

    window.metaAttributesCache.set('ol-aiAssistEnabled', true)
    window.metaAttributesCache.set('ol-showAiFeatures', true)

    const openDocContextValue: any = {
      openDocName,
      currentDocumentId: 'doc-1',
      currentDocument: { id: 'doc-1' },
      isPending: false,
      isPendingEditor: false,
    }

    render(
      <EditorOpenDocContext.Provider value={openDocContextValue}>
        <CodeMirrorViewContext.Provider value={view}>
          <ApplyFixListener />
        </CodeMirrorViewContext.Provider>
      </EditorOpenDocContext.Provider>
    )
  }

  function dispatchApplyEdit(detail: any): Promise<string> {
    return new Promise(resolve => {
      const onResult = (e: Event) => {
        window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
        resolve((e as CustomEvent).detail?.status)
      }
      window.addEventListener('aiAssist:agentApplyEditResult', onResult)
      window.dispatchEvent(new CustomEvent('aiAssist:agentApplyEdit', { detail }))
    })
  }

  beforeEach(function () {
    resetMeta()
  })

  afterEach(function () {
    cleanup()
    if (view) view.destroy()
    if (container && container.parentNode) {
      container.parentNode.removeChild(container)
    }
  })

  it('appends text to a document without trailing newline by prepending a newline', async function () {
    setupEditor('line 1\nline 2')

    const status = await dispatchApplyEdit({
      oldText: '',
      replacement: '\\section{Conclusion}',
      isAppend: true,
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal(
      'line 1\nline 2\n\\section{Conclusion}'
    )
  })

  it('appends text to a document with a trailing newline without extra blank line', async function () {
    setupEditor('line 1\nline 2\n')

    const status = await dispatchApplyEdit({
      oldText: '',
      replacement: '\\section{Conclusion}\n',
      isAppend: true,
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal(
      'line 1\nline 2\n\\section{Conclusion}\n'
    )
  })

  it('appends text to an empty document', async function () {
    setupEditor('')

    const status = await dispatchApplyEdit({
      oldText: '',
      replacement: '\\documentclass{article}',
      isAppend: true,
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal('\\documentclass{article}')
  })

  it('performs surgical sub-line replacement without wiping surrounding text', async function () {
    const initialText = 'See \\cite{oldKey} for full details.'
    setupEditor(initialText)

    const oldText = '\\cite{oldKey}'
    const fromOffset = initialText.indexOf(oldText)
    const toOffset = fromOffset + oldText.length

    const status = await dispatchApplyEdit({
      fromOffset,
      toOffset,
      oldText,
      replacement: '\\cite{newKey}',
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal(
      'See \\cite{newKey} for full details.'
    )
  })

  it('deletes an entire line cleanly without leaving a blank line', async function () {
    const initialText = 'line 1\nline 2\nline 3\n'
    setupEditor(initialText)

    const oldText = 'line 2'
    const fromOffset = initialText.indexOf(oldText)
    const toOffset = fromOffset + oldText.length

    const status = await dispatchApplyEdit({
      fromOffset,
      toOffset,
      oldText,
      replacement: '',
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal('line 1\nline 3\n')
  })

  it('deletes the final line of a document cleanly without leaving trailing blank line', async function () {
    const initialText = 'line 1\nline 2'
    setupEditor(initialText)

    const oldText = 'line 2'
    const fromOffset = initialText.indexOf(oldText)
    const toOffset = fromOffset + oldText.length

    const status = await dispatchApplyEdit({
      fromOffset,
      toOffset,
      oldText,
      replacement: '',
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal('line 1')
  })

  it('falls back to in-document search if offsets drifted but anchor is unique', async function () {
    setupEditor('alpha\nbeta\ngamma')

    const status = await dispatchApplyEdit({
      fromOffset: 0, // Stale offset
      toOffset: 5,
      oldText: 'beta',
      replacement: 'BETA',
    })

    expect(status).to.equal('applied')
    expect(view.state.doc.toString()).to.equal('alpha\nBETA\ngamma')
  })

  it('returns drifted if oldText cannot be found anywhere in the document', async function () {
    setupEditor('alpha\nbeta\ngamma')

    const status = await dispatchApplyEdit({
      oldText: 'delta',
      replacement: 'DELTA',
    })

    expect(status).to.equal('drifted')
    expect(view.state.doc.toString()).to.equal('alpha\nbeta\ngamma')
  })

  it('returns drifted if oldText is ambiguous and offsets do not match', async function () {
    setupEditor('alpha\nbeta\ngamma\nbeta\n')

    const status = await dispatchApplyEdit({
      fromOffset: 0, // Wrong offset
      toOffset: 4,
      oldText: 'beta',
      replacement: 'BETA',
    })

    expect(status).to.equal('drifted')
  })

  it('returns pathMismatch if target path does not match openDocName', async function () {
    setupEditor('content', 'main.tex')

    const status = await dispatchApplyEdit({
      path: 'chapters/intro.tex',
      oldText: 'content',
      replacement: 'new content',
    })

    expect(status).to.equal('pathMismatch')
    expect(view.state.doc.toString()).to.equal('content')
  })
})
```

- [ ] **Step 2: Run the test file**
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/apply-fix-listener.test.tsx
```
Expected: All 10 tests passing.

---

### Task 5: End-to-End Regression Verification & Tool Integration with `edit_file`

**Files:**
- Test: `modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts`
- Test: Full frontend suite across `modules/ai-assist/test/frontend`

- [ ] **Step 1: Run the full ai-assist frontend test suite**
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend
```
Expected: ≥774 passing, 0 failing.

- [ ] **Step 2: Run the full ai-assist backend test suite**
```bash
NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
```
Expected: 10 test files, 107 passing.

---

## Out of Scope

- **Document Path Switching and Tab Activation (Workstream 1):** Unsynchronized doc switching, reading inactive tabs, and `create_file` bridge injection are handled in WS1.
- **LaTeX Normalisation & Double-Backslash Unescaping (Workstream 3):** Parity between frontend and backend regex unescaping (`\\cmd` -> `\cmd`) and candidate line feedback are implemented in WS3.
- **Compiler Feedback Loop & Build Race Resolution (Workstream 4):** Awaiting compilation promises and before/after error delta tracking are implemented in WS4.
- **Global Context & Search Indexing (Workstream 5):** 50-hit project-wide search caps and directory glob pre-filtering are handled in WS5.

---

## Traps & Pitfalls for the Implementer

1. **TRAP: `length > 0` vs boundary newline in `spanToLineRange`:**
   When `length = 0` (e.g. at EOF or insertion), `text[index + length - 1]` would evaluate to `text[index - 1]`. If the preceding character was a newline, `effectiveEnd` would mistakenly subtract 1! Always guard with `length > 0 && text[index + length - 1] === '\n'`.

2. **TRAP: `proposeEdit` two-call `spanToLineRange` anti-pattern:**
   Do NOT call `spanToLineRange` twice (once at `span.index` and once at `span.index + edit.oldText.length` with `length = 0`). The second call with `length = 0` bypasses the newline adjustment and causes `endLine` to be off by one. Always unpack both `from` and `to` from a single call:
   ```ts
   const { from: startLine, to: endLine } = spanToLineRange(content, span.index, matchedLen)
   ```

3. **TRAP: Updating pre-existing test in `editor-bridge.test.ts`:**
   The pre-existing test in `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts:14-19` asserts `expect(findUniqueSpan(TEXT, 'gamma')).to.deep.equal({ status: 'found', index: 11 })`. When `findUniqueSpan` is updated to return `matchedLength: 5`, this test fails with a deep equality mismatch unless updated to include `matchedLength: 5`.

4. **TRAP: Clean Line Deletion Offset Adjustment & Trailing Newline:**
   In `adjustForCleanLineDeletion`, when deleting a line at the end of the document (EOF) where `cTo === doc.length` and `cFrom > 0 && docText[cFrom - 1] === '\n'`, the start offset must shift backward to consume the leading newline (`{ cFrom: cFrom - 1, cTo }`). Never return `{ cFrom, cTo: cFrom - 1 }`, which creates an inverted range (`from > to`) that throws a CodeMirror `RangeError`. Additionally, if `oldText` already ends with `\n` (`cTo > cFrom && docText[cTo - 1] === '\n'`), no newline adjustment should be made, avoiding double-newline deletion that erroneously merges adjacent lines.

5. **TRAP: Multi-Line `matchedLength` in Tier 2:**
   When calculating `matchedLength` for multi-line anchors in `findUniqueSpan` Tier 2, do not use `matchedLines.join('\n').length - lineOffset` directly if the last line of `oldText` only spans a prefix of the last line in the document. Accumulate intermediate line lengths and add only `Math.min(origLines[lineNum + oldLineCount - 1].length, oldLines[oldLineCount - 1].length)` for the final line.

6. **TRAP: Multi-Line Character Offset Normalization in `apply-fix-listener.tsx`:**
   `slice.trimEnd() === oldText.trimEnd()` only trims the very end of the whole multi-line string. If an anchor matched via Tier 2 has trailing whitespace on internal lines, line-by-line whitespace normalization (`slice.split('\n').map(l => l.trimEnd()).join('\n') === oldText.split('\n').map(l => l.trimEnd()).join('\n')`) is required so precision character-offset replacements succeed without falling back.

7. **TRAP: Sandboxed Mocha Runner vs Vitest:**
   Do not run `yarn test` or invoke mocha across the entire repository. Run `../../node_modules/.bin/mocha` from `services/web` scoped to `modules/ai-assist/test/frontend`. Vitest must be used for backend tests under `modules/ai-assist/test/unit/src`.

8. **TRAP: CodeMirror 6 `doc.length` vs Line Array Indexing:**
   CodeMirror coordinates are 0-indexed character offsets (`0 <= pos <= doc.length`). Line numbers in CodeMirror are 1-indexed (`1 <= lineNo <= doc.lines`). Do not confuse character offsets with line indices.

---

## Verification Commands & Baseline Expectation

Run from `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`:

1. **Targeted Bridge & Precision Unit Tests:**
   ```bash
   NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts modules/ai-assist/test/frontend/js/agent/apply-fix-listener.test.tsx modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts
   ```

2. **Full Frontend AI Assist Module Suite:**
   ```bash
   NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend
   ```
   **Expected passing:** ≥774 tests, 0 failures.

3. **Full Backend AI Assist Module Suite:**
   ```bash
   NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
   ```
   **Expected passing:** 10 test files, 107 tests passing.
