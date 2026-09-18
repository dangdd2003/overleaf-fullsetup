# AI Assist Error Panel on the Agent Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compile log pane's one-shot "Suggest fix" stack with a bounded agent run on the shared harness, so it can investigate across files before proposing a fix — without making the log entry any taller.

**Architecture:** The static `SYSTEM_PROMPT` is reused byte-for-byte; fix-specific instructions ride on the user turn as a `<task>` block alongside a new `<compile-error>` envelope. A `useAgentRun` hook is extracted from `agent-panel.tsx` so both surfaces share provider resolution, consent, approval plumbing and the event loop. The panel's `DiffView` is promoted into the shared `EditApprovalCard`, giving the rail better diffs in the same change.

**Tech Stack:** TypeScript, React 18, Mocha + Chai + @testing-library/react, Overleaf web module system (`modules/ai-assist`).

**Spec:** `overleaf/docs/superpowers/specs/2026-09-13-ai-assist-error-panel-agent-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **NO GIT WRITE COMMANDS.** Do not run `git add`, `git commit`, `git push`, `git stash`, `git branch`, `git rebase`, or `git checkout -b` at any point. This overrides the default "commit after each task" step in the subagent-driven-development and executing-plans skills. All work stays as uncommitted working-tree modifications. Verification steps use `git status --short` and `git diff --stat` only.
- **`SYSTEM_PROMPT` is byte-frozen.** Do not edit `agent/context/system-prompt.ts`. Any fix-specific instruction goes in the `<task>` block. Editing it silently costs a full cache re-read on every request on both surfaces.
- **Frontend only.** No Express route, no controller, no server-side inference proxy, no provider credential reaching the server. The module's `index.mjs` has no router and must not gain one.
- **Default off.** With `AI_ASSIST_ENABLED` unset, `ol-aiAssistEnabled` is false, every component returns null, and the instance behaves exactly like upstream Overleaf CE.
- **Test command — do not use `npm run test:frontend`.** That script's `--grep=${MOCHA_GREP:-}` is unquoted, so a pattern containing a space is word-split into extra positional arguments. Worse, its hardcoded spec glob (`test/frontend modules/*/test/frontend`) makes mocha load `modules/user-activate/test/frontend/js/components/user-activate-register.test.jsx`, which crashes the whole run with `ERR_UNKNOWN_FILE_EXTENSION` before any test executes — before grep filtering ever applies. This is pre-existing breakage in an unrelated module, verified 2026-09-13 against Node v24.18.0; it is not part of this plan's job to fix.

  Run mocha directly instead, scoped to this module, from `overleaf/services/web`:

  ```
  NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
    --extension js,jsx,mjs,ts,tsx \
    --grep="<pattern>" \
    --require test/frontend/bootstrap.js \
    --ignore '**/*.spec.{js,jsx,ts,tsx}' \
    --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
    modules/ai-assist/test/frontend
  ```

  Omit `--grep` entirely to run every test in the module. Always quote the pattern; it may contain spaces. `CoreWiring.test.mjs` is a **vitest** file, not mocha — run it with `npx vitest run modules/ai-assist/test/unit`, never with the command above.
- **Baseline is scoped, not full-suite.** The web unit suite has pre-existing failures on clean main, and — separately — cannot complete a full run at all in this environment, for the reason above. "Baseline" throughout this plan means the pass/fail counts of the command above run with no `--grep` against `modules/ai-assist/test/frontend`. Task 1 records this number; every later task compares against it, not against zero and not against a full-suite figure this environment cannot produce.
- **Do not rename** `data-action="suggest-fix"`, the `aiAssist:suggestFix` / `aiAssist:suggestDone` event names, or any of the four registered slot paths in `config/settings.defaults.js`. `use-log-events.ts:46` and `CoreWiring.test.mjs` both depend on them.
- **Path to the test helpers** from a module test at `modules/ai-assist/test/frontend/js/<dir>/`:
  `../../../../../../test/frontend/helpers/editor-providers`
- **Existing exports you will consume — all named, none default.** Import them exactly as written:
  - `import { ThinkingBlock } from './thinking-block'` — props `{ thinking: string; isLive?: boolean; elapsedMs?: number }`
  - `import { ToolCallCard } from './tool-call-card'` — props `{ call: ToolCallRecord }`
  - `import { MarkdownContent } from './markdown-content'` — props `{ content: string }`
  - `import { EditApprovalCard } from './edit-approval-card'` — props `{ edit: EditRequest; onDecision: (d) => void; decided?: 'accepted' | 'rejected' }`
  - `import { resolveLimits } from '../providers/types'` — **not** from a context module
  Writing `import ThinkingBlock from …` compiles to `undefined` and fails at render with a confusing error. Check each one against the file before writing the import.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `agent/agent-state.ts` | `AgentState`, `emptyAgentState`, `reduceAgentEvent` — pure event reduction, no React |
| `agent/context/compile-error.ts` | Renders `<compile-error>` and `<compile-log-index>` text |
| `agent/fix-run.ts` | `FIX_TOOLS`, `FIX_MAX_STEPS`, `buildFixTranscript` |
| `hooks/use-agent-run.ts` | Shared runner: provider, consent, approval, abort, event loop |
| `components/agent/diff-view.tsx` | Shared diff renderer, promoted from the panel |
| `components/agent/agent-work-row.tsx` | Collapsed thinking + tool-call timeline, one row |

**Modified:**

| Path | Change |
|---|---|
| `agent/project-handle.ts` | `requestApproval` context type |
| `agent/use-project-handle.ts` | Pass `startLine` to `requestApproval` |
| `components/agent/agent-panel.tsx` | Slimmed onto `useAgentRun`; state moved out |
| `components/agent/edit-approval-card.tsx` | Renders `DiffView` |
| `components/suggest-fix-panel.tsx` | Rewritten on the harness |
| `components/apply-fix-listener.tsx` | Drops retired-format listeners |
| `assistant.ts` | Drops `explainError` |

**Deleted:** `error-prompt.ts`, `hooks/use-fix-stream.ts`, `parse-fix-block.ts`, `apply-fix.ts`, and their four test files.

---

# Phase 1 — Shared foundations

## Task 1: Prove the provider tree

This is a gate, not a feature. The rewritten panel needs four React contexts it has never needed before. Prove the test harness supplies them before building anything on top.

**Files:**
- Test: `modules/ai-assist/test/frontend/js/agent/handle-in-log-pane.test.tsx` (create)

**Interfaces:**
- Consumes: `useProjectHandle` from `agent/use-project-handle`, `EditorProviders` from the web test helpers.
- Produces: nothing. Proves that `useProjectHandle` mounts under `EditorProviders`, which every later component test depends on.

- [ ] **Step 1: Write the test**

```tsx
import { expect } from 'chai'
import { render, screen, waitFor } from '@testing-library/react'
import { EditorProviders } from '../../../../../../test/frontend/helpers/editor-providers'
import { useProjectHandle } from '../../../../frontend/js/features/ai-assist/agent/use-project-handle'

function Probe() {
  const handle = useProjectHandle({
    requestApproval: async () => ({ accepted: false }),
  })

  const methods = [
    'rootDocPath',
    'listFiles',
    'readFile',
    'search',
    'currentSelection',
    'proposeEdit',
    'compile',
    'openFile',
    'lastCompile',
    'createFile',
  ]
  const missing = methods.filter(
    name => typeof (handle as any)[name] !== 'function'
  )

  return <div data-testid="probe">{missing.length ? missing.join(',') : 'ok'}</div>
}

describe('useProjectHandle inside the compile log pane', function () {
  it('resolves every context it needs under EditorProviders', async function () {
    render(
      <EditorProviders>
        <Probe />
      </EditorProviders>
    )

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).to.equal('ok')
    })
  })
})
```

- [ ] **Step 2: Run it**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="useProjectHandle inside the compile log pane" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS.

If it throws instead — a message like `useLocalCompileContext is only available inside LocalCompileProvider`, or a module resolution error on the helper path — that is the finding this task exists for. **Stop and report it.** Do not work around it by changing `useProjectHandle`. The fix belongs in how the test wraps the component, and the rest of the plan needs re-checking against whatever the real constraint turns out to be.

- [ ] **Step 3: Record the baseline**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend 2>&1 | tail -30
```

Write down the pass/fail counts. Every later task compares against this number, not against zero.

- [ ] **Step 4: Verify nothing was committed**

```
git status --short
```

Expected: the new test file shows as untracked. No commit was made.

---

## Task 2: Move agent state out of the component

`AgentState`, `emptyAgentState` and `reduceAgentEvent` are exported from `agent-panel.tsx`. `useAgentRun` returns an `AgentState`, so leaving them there would make the hook import from the component that imports the hook.

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/agent-state.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx`
- Create: `modules/ai-assist/test/frontend/js/agent/agent-state.test.ts`
- Delete: the `reduceAgentEvent` describe block from `modules/ai-assist/test/frontend/js/agent/components/agent-panel.test.tsx`

**Interfaces:**
- Produces: `AgentState`, `emptyAgentState(transcript: TranscriptEntry[]): AgentState`, `reduceAgentEvent(state: AgentState, event: AgentEvent): AgentState` — all from `agent/agent-state`. Tasks 6 and 10 import from here.

- [ ] **Step 1: Move the code**

Cut the `AgentState` type, `emptyAgentState`, and `reduceAgentEvent` out of `agent-panel.tsx` verbatim into a new `agent/agent-state.ts`. Do not change their bodies — this task is a move, and any behaviour change here is indistinguishable from a regression.

The new file's imports:

```ts
import { AgentEvent } from './agent-events'
import { TranscriptEntry } from './agent-messages'
```

Then in `agent-panel.tsx`, replace the removed definitions with:

```ts
import {
  AgentState,
  emptyAgentState,
  reduceAgentEvent,
} from '../../agent/agent-state'
```

- [ ] **Step 2: Move the tests**

Create `modules/ai-assist/test/frontend/js/agent/agent-state.test.ts` containing the `describe('reduceAgentEvent', ...)` block moved verbatim from `agent-panel.test.tsx`, with the import changed to:

```ts
import {
  reduceAgentEvent,
  emptyAgentState,
} from '../../../../frontend/js/features/ai-assist/agent/agent-state'
```

Delete that describe block and its now-unused imports from `agent-panel.test.tsx`.

- [ ] **Step 3: Run both suites**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="reduceAgentEvent" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS, same number of tests as before the move.

- [ ] **Step 4: Run the rail's full suite**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: 451 passing, 0 failing, 0 pending — the Task 1 baseline, run with no `--grep` since `--grep="agent"` is case-sensitive and misses most of this module's own test titles (they say "Agent", capitalized). This is a pure move; any change here is a bug you just introduced.

- [ ] **Step 5: Verify no commit**

```
git status --short
```

---

## Task 3: Carry the start line through approval

`DiffView` renders line-number gutters. `EditRequest` carries anchors, not positions. `proposeEdit` already computes the position to tell `noMatch` from `ambiguous`, so it only needs to pass it on.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/handle-context.test.ts`

**Interfaces:**
- Produces: `requestApproval(edit: EditRequest, context: { startLine: number }): Promise<{ accepted: boolean; note?: string }>`. Tasks 5, 6 and 10 depend on this second argument.

- [ ] **Step 1: Write the failing test**

Add to `modules/ai-assist/test/frontend/js/agent/handle-context.test.ts`:

```ts
it('tells the approver which line the edit starts on', async function () {
  const seen: Array<{ startLine: number }> = []
  const handle = createFakeHandle({
    docs: { 'main.tex': 'line one\nline two\nline three' },
  })

  // The fake handle stands in for the real one; this asserts the contract the
  // real proposeEdit must honour, which Step 3 implements.
  await handle.proposeEdit({
    path: 'main.tex',
    oldText: 'line two',
    newText: 'line 2',
  })

  expect(handle.approvalContexts).to.deep.equal([{ startLine: 2 }])
})
```

Extend `test/frontend/js/agent/helpers/fake-handle.ts` to record it. Add to `FakeHandleOptions` nothing new; instead record on the returned object:

```ts
const approvalContexts: Array<{ startLine: number }> = []
```

and inside the fake `proposeEdit`, before returning, compute and push:

```ts
const text = docs[edit.path] ?? ''
const index = text.indexOf(edit.oldText)
if (index !== -1) {
  approvalContexts.push({
    startLine: text.slice(0, index).split('\n').length,
  })
}
```

Expose `approvalContexts` on the returned handle object alongside the existing `calls`.

- [ ] **Step 2: Run it to see it fail**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="tells the approver which line" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: FAIL — `approvalContexts` is undefined.

- [ ] **Step 3: Implement in the fake, then the real handle**

Apply the Step 1 fake-handle change so the test passes, then make the real handle honour the same contract.

In `agent/project-handle.ts`, no change is needed to `EditRequest`. In `agent/use-project-handle.ts`, widen the prop type:

```ts
export function useProjectHandle({
  requestApproval,
}: {
  requestApproval: (
    edit: EditRequest,
    context: { startLine: number }
  ) => Promise<{ accepted: boolean; note?: string }>
}): ProjectHandle {
```

Inside `proposeEdit`, the code already locates `oldText` to count matches. At the point where it has a single confirmed match offset, compute the 1-indexed line and pass it:

```ts
const startLine = content.slice(0, matchIndex).split('\n').length
const decision = await requestApproval(edit, { startLine })
```

In `agent-panel.tsx`, widen `requestApproval` to accept and stash the context so the approval card can read it:

```ts
const approvalContextRef = useRef<{ startLine: number } | null>(null)

const requestApproval = useCallback(
  (_edit: EditRequest, context: { startLine: number }) =>
    new Promise<{ accepted: boolean; note?: string }>(resolve => {
      approvalRef.current = resolve
      approvalContextRef.current = context
    }),
  []
)
```

- [ ] **Step 4: Run the test**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="tells the approver which line" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS.

- [ ] **Step 5: Run the rail's suite**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: 451 passing, 0 failing, 0 pending (the Task 1 baseline, run with no `--grep`).

- [ ] **Step 6: Verify no commit**

```
git status --short
```

---

## Task 4: Promote DiffView

`DiffView` and `computeInlineDiff` move out of `suggest-fix-panel.tsx` into a shared component, re-typed off `ParsedFix` and onto the `edit_file` shape, and gain a fold for long hunks.

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/diff-view.tsx`
- Create: `modules/ai-assist/test/frontend/js/agent/components/diff-view.test.tsx`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/suggest-fix-panel.tsx` (import from the new location; full rewrite comes in Task 10)

**Interfaces:**
- Produces: `default function DiffView({ oldText, newText, startLine }: { oldText: string; newText: string; startLine: number })`. Task 5 renders it inside `EditApprovalCard`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import DiffView from '../../../../../frontend/js/features/ai-assist/components/agent/diff-view'

describe('DiffView', function () {
  it('highlights only the changed span on a single-line edit', function () {
    render(
      <DiffView
        oldText="\usepackage{title asfsa sec}"
        newText="\usepackage{titlesec}"
        startLine={13}
      />
    )

    expect(screen.getByText('title asfsa sec')).to.have.class('diff-del')
    expect(screen.getByText('titlesec')).to.have.class('diff-ins')
    expect(screen.getAllByText(/13/)).to.have.length.greaterThan(0)
  })

  it('renders an unchanged line as context, not as delete plus insert', function () {
    const { container } = render(
      <DiffView
        oldText={'\\alpha\n\\beta\n\\gamma'}
        newText={'\\alpha\n\\BETA\n\\gamma'}
        startLine={5}
      />
    )

    expect(container.querySelectorAll('.diff-line-context')).to.have.length(2)
    expect(container.querySelectorAll('.diff-line-del')).to.have.length(1)
    expect(container.querySelectorAll('.diff-line-ins')).to.have.length(1)
  })

  it('folds the middle of a long hunk', function () {
    const oldText = Array.from({ length: 40 }, (_unused, i) => `old ${i}`).join('\n')
    const newText = Array.from({ length: 40 }, (_unused, i) => `new ${i}`).join('\n')

    render(<DiffView oldText={oldText} newText={newText} startLine={1} />)

    expect(screen.getByText(/more lines/)).to.exist
  })
})
```

- [ ] **Step 2: Run to see them fail**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="DiffView" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: FAIL — cannot resolve `components/agent/diff-view`.

- [ ] **Step 3: Implement**

Create `components/agent/diff-view.tsx`. Move `computeInlineDiff` verbatim from `suggest-fix-panel.tsx`, then port the `DiffView` body with three changes: it derives its line arrays from `oldText`/`newText` instead of `docLines` and `fix`, it numbers from `startLine`, and it folds long hunks.

```tsx
import React from 'react'
import { diffLines } from 'diff'

const MAX_ROWS = 12

export function computeInlineDiff(original: string, replacement: string) {
  let start = 0
  while (
    start < original.length &&
    start < replacement.length &&
    original[start] === replacement[start]
  ) {
    start++
  }

  let origEnd = original.length - 1
  let replEnd = replacement.length - 1
  while (
    origEnd >= start &&
    replEnd >= start &&
    original[origEnd] === replacement[replEnd]
  ) {
    origEnd--
    replEnd--
  }

  return {
    prefix: original.slice(0, start),
    origMiddle: original.slice(start, origEnd + 1),
    replMiddle: replacement.slice(start, replEnd + 1),
    suffix: original.slice(origEnd + 1),
  }
}

export default function DiffView({
  oldText,
  newText,
  startLine,
}: {
  oldText: string
  newText: string
  startLine: number
}) {
  // create_file and the creation branch of EditApprovalCard both pass an empty
  // oldText. ''.split('\n') is [''], which would render a bogus deleted blank
  // line, so creations render as pure insertion.
  if (oldText === '') {
    return (
      <div className="ai-suggest-code-diff">
        {newText.split('\n').map((line, index) => (
          <div key={index} className="diff-line diff-line-ins">
            <span className="diff-gutter">+ {startLine + index}</span>
            <span className="diff-content">
              <mark className="diff-ins">{line}</mark>
            </span>
          </div>
        ))}
      </div>
    )
  }

  const origLines = oldText.split('\n')
  const replLines = newText.split('\n')

  if (origLines.length === 1 && replLines.length === 1) {
    const diff = computeInlineDiff(origLines[0], replLines[0])
    return (
      <div className="ai-suggest-code-diff">
        <div className="diff-line diff-line-del">
          <span className="diff-gutter">- {startLine}</span>
          <span className="diff-content">
            {diff.prefix}
            {diff.origMiddle && (
              <mark className="diff-del">{diff.origMiddle}</mark>
            )}
            {diff.suffix}
          </span>
        </div>
        <div className="diff-line diff-line-ins">
          <span className="diff-gutter">+ {startLine}</span>
          <span className="diff-content">
            {diff.prefix}
            {diff.replMiddle && (
              <mark className="diff-ins">{diff.replMiddle}</mark>
            )}
            {diff.suffix}
          </span>
        </div>
      </div>
    )
  }

  // A trailing newline on both sides is required: diffLines treats a line's
  // newline as part of its identity, so without it the last line of one side
  // never matches the same text mid-string on the other, and the whole block
  // degrades to a full delete plus insert.
  const chunks = diffLines(origLines.join('\n') + '\n', replLines.join('\n') + '\n')
  let origLineNo = startLine
  let replLineNo = startLine
  const rows: React.ReactNode[] = []

  chunks.forEach((chunk, chunkIndex) => {
    const lines = chunk.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()

    lines.forEach((line, idx) => {
      if (chunk.removed) {
        rows.push(
          <div key={`del-${chunkIndex}-${idx}`} className="diff-line diff-line-del">
            <span className="diff-gutter">- {origLineNo}</span>
            <span className="diff-content">
              <mark className="diff-del">{line}</mark>
            </span>
          </div>
        )
        origLineNo++
      } else if (chunk.added) {
        rows.push(
          <div key={`ins-${chunkIndex}-${idx}`} className="diff-line diff-line-ins">
            <span className="diff-gutter">+ {replLineNo}</span>
            <span className="diff-content">
              <mark className="diff-ins">{line}</mark>
            </span>
          </div>
        )
        replLineNo++
      } else {
        rows.push(
          <div key={`ctx-${chunkIndex}-${idx}`} className="diff-line diff-line-context">
            <span className="diff-gutter">{replLineNo}</span>
            <span className="diff-content">{line}</span>
          </div>
        )
        origLineNo++
        replLineNo++
      }
    })
  })

  // The log entry is a narrow, crowded column. A long hunk must not push the
  // rest of the compile log off screen, so the middle collapses.
  if (rows.length > MAX_ROWS) {
    const head = rows.slice(0, MAX_ROWS / 2)
    const tail = rows.slice(rows.length - MAX_ROWS / 2)
    const hidden = rows.length - MAX_ROWS
    return (
      <div className="ai-suggest-code-diff">
        {head}
        <div className="diff-line diff-line-fold">
          <span className="diff-gutter" />
          <span className="diff-content">… {hidden} more lines</span>
        </div>
        {tail}
      </div>
    )
  }

  return <div className="ai-suggest-code-diff">{rows}</div>
}
```

- [ ] **Step 4: Add the horizontal scroll rule**

In `frontend/stylesheets/components/ai-assist.scss`, ensure `.ai-suggest-code-diff .diff-content` does not wrap:

```scss
.ai-suggest-code-diff {
  overflow-x: auto;

  .diff-content {
    white-space: pre;
  }
}
```

LaTeX source lines are long and the column is narrow; wrapping destroys the `-`/`+` alignment that makes the change readable at a glance.

- [ ] **Step 5: Point the old panel at the new module**

In `suggest-fix-panel.tsx`, delete the local `DiffView` and `computeInlineDiff`, and import the new component. The call site still has a `ParsedFix`, so adapt at the boundary — this is temporary scaffolding that Task 10 deletes:

```tsx
import DiffView from './agent/diff-view'

// ...at the call site, replacing <DiffView fix={parsed.fix} docLines={docLines} />:
<DiffView
  oldText={(docLines ?? []).slice(parsed.fix.from - 1, parsed.fix.to).join('\n')}
  newText={parsed.fix.replacement}
  startLine={parsed.fix.from}
/>
```

- [ ] **Step 6: Run the tests**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="DiffView|suggest fix panel" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS for both the new `DiffView` tests and the existing panel tests. The panel still works; only where the diff code lives has changed.

- [ ] **Step 7: Verify no commit**

```
git status --short
```

---

## Task 5: EditApprovalCard adopts DiffView

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/edit-approval-card.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/components/transcript.test.tsx`

**Interfaces:**
- Produces: `EditApprovalCard` gains a `startLine: number` prop and renders `DiffView`. Task 10 renders this component.

- [ ] **Step 1: Write the failing test**

Add to `transcript.test.tsx`:

```tsx
it('renders the approval diff with gutters and word-level highlighting', function () {
  const { container } = render(
    <EditApprovalCard
      edit={{
        path: 'main.tex',
        oldText: '\\usepackage{title asfsa sec}',
        newText: '\\usepackage{titlesec}',
      }}
      startLine={13}
      onDecision={() => {}}
    />
  )

  expect(container.querySelector('.diff-line-del')).to.exist
  expect(container.querySelector('.diff-gutter')?.textContent).to.contain('13')
})
```

- [ ] **Step 2: Run to see it fail**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="renders the approval diff with gutters" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: FAIL — no `.diff-line-del` in the rendered output, because the card still renders a `<pre>`.

- [ ] **Step 3: Implement**

Two things already in this file that you must not break:

- It has a `decided?: 'accepted' | 'rejected'` prop that locks the card after a
  decision. Keep it. Task 10 does **not** reuse it for receipts — a locked card
  still renders its full diff, and the receipt has to be one line — but the rail
  depends on it.
- It computes `const isCreation = !edit.oldText` and renders creations
  differently. `DiffView` handles an empty `oldText` as a pure insertion
  (Task 4), so pass the edit through unchanged and let `DiffView` decide.

In `edit-approval-card.tsx`, add `startLine: number` to the props type and replace the `<pre className="ai-assist-diff">` block with:

```tsx
<DiffView
  oldText={edit.oldText}
  newText={edit.newText}
  startLine={startLine}
/>
```

Import it: `import DiffView from './diff-view'`.

- [ ] **Step 4: Run the test**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="renders the approval diff with gutters" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS.

- [ ] **Step 5: Run the rail's suite**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: 451 passing, 0 failing, 0 pending (the Task 1 baseline, run with no `--grep`), plus any new tests this task added. Any existing assertion on `.ai-assist-diff` needs updating to the new markup — that is a legitimate change, not a regression, but read each one before changing it.

- [ ] **Step 6: Verify no commit**

```
git status --short
```

---

## Task 6: Extract useAgentRun

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/hooks/use-agent-run.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/components/agent-panel.test.tsx`

**Interfaces:**
- Produces:

```ts
export function useAgentRun(options: {
  tools: Record<string, AgentTool>
  maxSteps: number
  cacheKey?: string
}): {
  state: AgentState
  running: boolean
  error: { code: string; message: string } | null
  handle: ProjectHandle
  approvalContext: { startLine: number } | null
  run(transcript: TranscriptEntry[]): Promise<void>
  stop(): void
  onDecision(decision: { accepted: boolean; note?: string }): void
  needsConsent: boolean
  allowConsent(): void
}
```

Task 10 consumes this.

- [ ] **Step 1: Write the hook**

Move, without behaviour changes, out of `agent-panel.tsx`: the `AiAssistant.fromStoredSettings()` resolution and its `noProvider` error, the `hasConsented()` gate, `approvalRef` / `approvalContextRef` / `requestApproval` / `onDecision`, the `useProjectHandle` call, `abortRef`, and the `for await (const event of runAgent(...))` loop.

```ts
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AiAssistant } from '../assistant'
import { hasConsented, recordConsent } from '../provider-store'
import { runAgent } from '../agent/run-agent'
import { resolveLimits } from '../providers/types'
import { useProjectHandle } from '../agent/use-project-handle'
import { AgentTool } from '../agent/tools/registry'
import { EditRequest, ProjectHandle } from '../agent/project-handle'
import { TranscriptEntry } from '../agent/agent-messages'
import {
  AgentState,
  emptyAgentState,
  reduceAgentEvent,
} from '../agent/agent-state'

export function useAgentRun({
  tools,
  maxSteps,
  cacheKey,
}: {
  tools: Record<string, AgentTool>
  maxSteps: number
  cacheKey?: string
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<AgentState>(emptyAgentState([]))
  const [needsConsent, setNeedsConsent] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const approvalRef = useRef<
    ((decision: { accepted: boolean; note?: string }) => void) | null
  >(null)
  const [approvalContext, setApprovalContext] = useState<{
    startLine: number
  } | null>(null)

  const requestApproval = useCallback(
    (_edit: EditRequest, context: { startLine: number }) =>
      new Promise<{ accepted: boolean; note?: string }>(resolve => {
        approvalRef.current = resolve
        setApprovalContext(context)
      }),
    []
  )

  const handle = useProjectHandle({ requestApproval })

  const onDecision = useCallback(
    (decision: { accepted: boolean; note?: string }) => {
      approvalRef.current?.(decision)
      approvalRef.current = null
      setApprovalContext(null)
    },
    []
  )

  const run = useCallback(
    async (transcript: TranscriptEntry[]) => {
      const assistant = AiAssistant.fromStoredSettings()
      if (!assistant) {
        setState(current => ({
          ...current,
          error: {
            code: 'noProvider',
            message: t(
              'ai_assist_configure_provider',
              'Configure an AI provider in Account Settings to use the assistant.'
            ),
          },
        }))
        return
      }
      if (!hasConsented()) {
        setNeedsConsent(true)
        return
      }

      const controller = new AbortController()
      abortRef.current = controller
      setState(current => ({
        ...current,
        transcript,
        running: true,
        stoppedForBudget: false,
        error: null,
      }))

      for await (const event of runAgent({
        client: assistant.client,
        handle,
        tools,
        transcript,
        limits: resolveLimits(assistant.settings),
        cacheKey,
        maxSteps,
        signal: controller.signal,
      })) {
        setState(current => reduceAgentEvent(current, event))
      }

      abortRef.current = null
    },
    [handle, tools, maxSteps, cacheKey, t]
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    approvalRef.current?.({ accepted: false })
    approvalRef.current = null
    setApprovalContext(null)
  }, [])

  const allowConsent = useCallback(() => {
    recordConsent()
    setNeedsConsent(false)
  }, [])

  return {
    state,
    setState,
    running: state.running,
    error: state.error,
    handle,
    approvalContext,
    run,
    stop,
    onDecision,
    needsConsent,
    allowConsent,
  }
}
```

`resolveLimits` is already exported from `providers/types.ts:36` and imported by
`agent-panel.tsx:22`. Import it from there; do not move or redefine it.

- [ ] **Step 2: Rewire the panel**

`AgentPanel` keeps: transcript persistence via `saveConversation`, the composer, the `files` list for `@`-mentions, `onNewChat`, the consent modal UI, and `buildUserEntry`/`onSend`. It replaces its own runner internals with `useAgentRun({ tools: TOOLS, maxSteps: MAX_STEPS, cacheKey: projectId })`.

The panel's `state` now comes from the hook, so `setState` is returned above for the panel's own transcript seeding on mount.

- [ ] **Step 3: Run the rail's full suite**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: 451 passing, 0 failing, 0 pending (the Task 1 baseline, run with no `--grep`), plus any new tests this task added. This task is behaviour-preserving; the rail's suite is the only thing standing between this refactor and a silent regression. If a test fails, fix the extraction, not the test.

- [ ] **Step 4: Confirm the panel actually shrank**

```
cd overleaf/services/web
wc -l modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx
```

Expected: meaningfully below 583. If it did not shrink, the logic was copied rather than moved and the duplication this task exists to prevent is now real.

- [ ] **Step 5: Verify no commit**

```
git status --short
```

---

# Phase 2 — The fix turn

## Task 7: The compile-error envelope

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/compile-error.ts`
- Create: `modules/ai-assist/test/frontend/js/context/compile-error.test.ts`

**Interfaces:**
- Produces: `FocusedLogEntry`, `LogIndexEntry`, `renderCompileError({ focused, others }): string`. Task 8 consumes it.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect } from 'chai'
import {
  renderCompileError,
} from '../../../../frontend/js/features/ai-assist/agent/context/compile-error'

describe('renderCompileError', function () {
  it('renders the focused entry with its raw log', function () {
    const text = renderCompileError({
      focused: {
        level: 'error',
        message: 'Undefined control sequence \\includegraphics',
        raw: '! Undefined control sequence.\nl.87 \\includegraphics',
        file: 'chapter3.tex',
        line: 87,
      },
      others: [],
    })

    expect(text).to.contain(
      '<compile-error file="chapter3.tex" line="87" level="error">'
    )
    expect(text).to.contain('Undefined control sequence \\includegraphics')
    expect(text).to.contain('<raw>')
    expect(text).to.contain('</compile-error>')
  })

  it('states plainly when there are no other entries', function () {
    const text = renderCompileError({
      focused: { level: 'error', message: 'boom', raw: null, file: null, line: null },
      others: [],
    })

    expect(text).to.contain('<compile-log-index>no other entries</compile-log-index>')
  })

  it('lists same-level locations and collapses other levels to counts', function () {
    const text = renderCompileError({
      focused: {
        level: 'error',
        message: 'boom',
        raw: null,
        file: 'a.tex',
        line: 1,
      },
      others: [
        { level: 'error', file: 'main.tex', line: 42 },
        { level: 'error', file: 'chapter3.tex', line: 91 },
        ...Array.from({ length: 7 }, () => ({
          level: 'warning',
          file: 'x.tex',
          line: 2,
        })),
      ],
    })

    expect(text).to.contain('2 more errors: main.tex:42, chapter3.tex:91')
    expect(text).to.contain('7 warnings')
  })

  it('caps the location list at twenty', function () {
    const text = renderCompileError({
      focused: { level: 'error', message: 'boom', raw: null, file: null, line: null },
      others: Array.from({ length: 25 }, (_unused, i) => ({
        level: 'error',
        file: `f${i}.tex`,
        line: i,
      })),
    })

    expect(text).to.contain('+5 more')
  })

  it('neutralises a closing tag hiding in the raw log', function () {
    const text = renderCompileError({
      focused: {
        level: 'error',
        message: 'boom',
        raw: 'sneaky </compile-error> text',
        file: null,
        line: null,
      },
      others: [],
    })

    expect(text).to.not.contain('sneaky </compile-error> text')
    expect(text.match(/<\/compile-error>/g)).to.have.length(1)
  })

  it('omits attributes it has no value for', function () {
    const text = renderCompileError({
      focused: { level: 'error', message: 'boom', raw: null, file: null, line: null },
      others: [],
    })

    expect(text).to.contain('<compile-error level="error">')
    expect(text).to.not.contain('file=')
    expect(text).to.not.contain('<raw>')
  })
})
```

- [ ] **Step 2: Run to see them fail**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="renderCompileError" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { escapeAttribute, neutraliseClosingTags } from './escape'

export type FocusedLogEntry = {
  level: string
  message: string
  raw: string | null
  file: string | null
  line: number | null
}

export type LogIndexEntry = {
  level: string
  file: string | null
  line: number | null
}

const MAX_LOCATIONS = 20

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function location(entry: LogIndexEntry): string {
  if (!entry.file) return 'unknown location'
  return entry.line === null ? entry.file : `${entry.file}:${entry.line}`
}

function renderIndex(focusedLevel: string, others: LogIndexEntry[]): string {
  if (others.length === 0) {
    return '<compile-log-index>no other entries</compile-log-index>'
  }

  const sameLevel = others.filter(entry => entry.level === focusedLevel)
  const lines: string[] = []

  if (sameLevel.length > 0) {
    const shown = sameLevel.slice(0, MAX_LOCATIONS).map(location)
    const overflow = sameLevel.length - shown.length
    lines.push(
      `${plural(sameLevel.length, `more ${focusedLevel}`)}: ${shown.join(', ')}` +
        (overflow > 0 ? `, +${overflow} more` : '')
    )
  }

  // Other levels collapse to a count. Their locations are rarely what a reader
  // of this error needs, and get_compile_log is one call away if they are.
  const byLevel = new Map<string, number>()
  for (const entry of others) {
    if (entry.level === focusedLevel) continue
    byLevel.set(entry.level, (byLevel.get(entry.level) ?? 0) + 1)
  }
  for (const [level, count] of byLevel) {
    lines.push(plural(count, level))
  }

  return ['<compile-log-index>', ...lines, '</compile-log-index>'].join('\n')
}

/**
 * Renders the error the user clicked, plus a thin index of everything else.
 *
 * The index exists so the model can tell a root cause from a downstream
 * symptom: one unclosed brace produces a cascade of entries, and a fix aimed at
 * the last of them patches a symptom. It costs about thirty tokens; detail is
 * pulled lazily with get_compile_log when the index looks suspicious.
 */
export function renderCompileError({
  focused,
  others,
}: {
  focused: FocusedLogEntry
  others: LogIndexEntry[]
}): string {
  const attributes = [
    focused.file ? ` file="${escapeAttribute(focused.file)}"` : '',
    focused.line !== null ? ` line="${focused.line}"` : '',
    ` level="${escapeAttribute(focused.level)}"`,
  ].join('')

  const body = [`<compile-error${attributes}>`, neutraliseClosingTags(focused.message)]

  if (focused.raw) {
    body.push('<raw>', neutraliseClosingTags(focused.raw), '</raw>')
  }

  body.push('</compile-error>')

  return [...body, renderIndex(focused.level, others)].join('\n')
}
```

- [ ] **Step 4: Teach `escape.ts` the new tag names**

`neutraliseClosingTags(value)` takes one argument and neutralises a fixed list
of tag names held in `ENVELOPE_CLOSING_TAGS`. That list currently contains
`project-context`, `files`, `compile`, `open-file`, `selection`, `attachments`
and `file` — **none of the tags this task introduces.** Without this step the
closing-tag test fails and, worse, a raw LaTeX log containing
`</compile-error>` could forge the envelope boundary.

In `agent/context/escape.ts`, extend the list:

```ts
const ENVELOPE_CLOSING_TAGS = [
  'project-context',
  'files',
  'compile',
  'open-file',
  'selection',
  'attachments',
  'file',
  'compile-error',
  'compile-log-index',
  'raw',
]
```

Run the existing escape tests afterwards to confirm the wider pattern did not
change how the project envelope escapes anything:

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="project-context|renderEnvelope" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS, unchanged.

- [ ] **Step 5: Run the tests**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="renderCompileError" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS, all six.

- [ ] **Step 6: Verify no commit**

```
git status --short
```

---

## Task 8: fix-run

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/fix-run.ts`
- Create: `modules/ai-assist/test/frontend/js/agent/fix-run.test.ts`

**Interfaces:**
- Produces: `FIX_TOOLS`, `FIX_MAX_STEPS`, `buildFixTranscript({ handle, focused, others }): Promise<TranscriptEntry[]>`, and `FIX_TASK_BLOCK`. Task 10 consumes all four.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect } from 'chai'
import {
  FIX_TOOLS,
  FIX_MAX_STEPS,
  FIX_TASK_BLOCK,
  buildFixTranscript,
} from '../../../../frontend/js/features/ai-assist/agent/fix-run'
import { createFakeHandle } from './helpers/fake-handle'

const FOCUSED = {
  level: 'error',
  message: 'Undefined control sequence',
  raw: 'l.87 \\includegraphics',
  file: 'chapter3.tex',
  line: 87,
}

describe('fix-run', function () {
  it('offers seven tools, excluding compile and create', function () {
    expect(Object.keys(FIX_TOOLS).sort()).to.deep.equal([
      'edit_file',
      'get_compile_log',
      'list_files',
      'list_references',
      'outline_project',
      'read_file',
      'search_project',
    ])
    expect(FIX_TOOLS).to.not.have.property('compile_project')
    expect(FIX_TOOLS).to.not.have.property('create_file')
  })

  it('caps the loop well below the rail', function () {
    expect(FIX_MAX_STEPS).to.equal(6)
  })

  it('builds one user entry carrying both envelopes and the task', async function () {
    const handle = createFakeHandle({ docs: { 'main.tex': 'hello' } })
    const transcript = await buildFixTranscript({
      handle,
      focused: FOCUSED,
      others: [],
    })

    expect(transcript).to.have.length(1)
    const entry = transcript[0]
    expect(entry.role).to.equal('user')
    expect(entry.contextText).to.contain('<project-context turn="1">')
    expect(entry.contextText).to.contain('<compile-error')
    expect(entry.text).to.equal(FIX_TASK_BLOCK)
    expect((entry as any).attachments).to.deep.equal([])
  })

  it('still explains the error when the snapshot cannot be built', async function () {
    const handle = createFakeHandle({})
    handle.listFiles = async () => {
      throw new Error('file tree unavailable')
    }

    const transcript = await buildFixTranscript({
      handle,
      focused: FOCUSED,
      others: [],
    })

    expect(transcript).to.have.length(1)
    expect(transcript[0].contextText).to.contain('<compile-error')
    expect(transcript[0].contextText).to.not.contain('<project-context')
  })
})
```

- [ ] **Step 2: Run to see them fail**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="fix-run" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { ProjectHandle } from './project-handle'
import { TranscriptEntry } from './agent-messages'
import { AgentTool, TOOLS } from './tools/registry'
import { ContextSnapshot } from './context/types'
import { renderEnvelope } from './context/project-context'
import {
  FocusedLogEntry,
  LogIndexEntry,
  renderCompileError,
} from './context/compile-error'

/**
 * The tools a fix run may use.
 *
 * compile_project is excluded because it cannot help: the edit is pending the
 * user's approval while the model is deciding what to say, so a compile would
 * rebuild the unchanged document and verify nothing. create_file is excluded
 * because a compile error is a fix, not a new file.
 */
export const FIX_TOOLS: Record<string, AgentTool> = Object.fromEntries(
  Object.entries(TOOLS).filter(
    ([name]) => name !== 'compile_project' && name !== 'create_file'
  )
)

/** Well below the rail's 30: this is one click, and the user is waiting. */
export const FIX_MAX_STEPS = 6

export const FIX_TASK_BLOCK = [
  '<task>',
  'The user clicked "Suggest fix" on the compile error above.',
  '',
  '1. Explain the cause in two or three sentences, in plain language.',
  '2. Investigate before you conclude. The error line is where LaTeX noticed',
  '   the problem, not always where it is: a missing \\usepackage in the',
  '   preamble surfaces at the first command that needs it, and an unclosed',
  '   brace surfaces far below itself. Check the preamble and the compile log',
  '   index before you assume the fix is local.',
  '3. If you are confident, call edit_file. The fix may belong in a different',
  '   file from the one the error names. If you are not confident, say what the',
  '   user should check instead and make no edit.',
  '',
  'compile_project and create_file are not available for this task. Do not',
  'offer to compile; the user will rebuild when they apply your fix.',
  '</task>',
].join('\n')

/**
 * Builds the single-turn transcript a fix run starts from.
 *
 * The envelope is rendered once here and frozen onto the entry, the same
 * contract the rail uses. A fix run is one turn, so there is never a previous
 * envelope to delta against.
 */
export async function buildFixTranscript({
  handle,
  focused,
  others,
}: {
  handle: ProjectHandle
  focused: FocusedLogEntry
  others: LogIndexEntry[]
}): Promise<TranscriptEntry[]> {
  const errorBlock = renderCompileError({ focused, others })

  let contextText = errorBlock
  try {
    const compile = handle.lastCompile()
    const snapshot: ContextSnapshot = {
      rootDocPath: handle.rootDocPath(),
      files: await handle.listFiles(),
      openFile: handle.openFile(),
      selection: handle.currentSelection(),
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
      attachments: [],
      turn: 1,
      previous: null,
    })
    contextText = `${envelope.text}\n${errorBlock}`
  } catch {
    // A file tree that will not load must not stop the user getting an
    // explanation. The error itself is the part that matters most.
  }

  return [
    {
      id: 'u0',
      role: 'user',
      text: FIX_TASK_BLOCK,
      contextText,
      attachments: [],
    },
  ]
}
```

- [ ] **Step 4: Run the tests**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="fix-run" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS, all four.

- [ ] **Step 5: Verify no commit**

```
git status --short
```

---

# Phase 3 — The panel

## Task 9: The work row

One collapsed row standing in for thinking plus every tool call, because the log entry cannot afford seven.

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-work-row.tsx`
- Create: `modules/ai-assist/test/frontend/js/agent/components/agent-work-row.test.tsx`

**Interfaces:**
- Produces: `default function AgentWorkRow({ blocks, running, thinkingMs }: { blocks: AssistantBlock[]; running: boolean; thinkingMs?: number })`. Task 10 renders it.

- [ ] **Step 1: Write the failing tests**

```tsx
import { expect } from 'chai'
import { render, screen, fireEvent } from '@testing-library/react'
import AgentWorkRow from '../../../../../frontend/js/features/ai-assist/components/agent/agent-work-row'

const BLOCKS = [
  { type: 'thinking' as const, thinking: 'considering the preamble' },
  {
    type: 'tool_call' as const,
    call: { id: '1', name: 'read_file', args: { path: 'main.tex' }, result: {} },
  },
  {
    type: 'tool_call' as const,
    call: { id: '2', name: 'list_references', args: {}, result: {} },
  },
]

describe('AgentWorkRow', function () {
  it('collapses to a single summary row', function () {
    const { container } = render(
      <AgentWorkRow blocks={BLOCKS} running={false} thinkingMs={4000} />
    )

    expect(screen.getByText(/Thought for 4s/)).to.exist
    expect(screen.getByText(/2 tools/)).to.exist
    // Collapsed: the individual calls are not in the document yet.
    expect(container.querySelectorAll('.ai-assist-tool-call')).to.have.length(0)
  })

  it('expands to the calls in the order they happened', function () {
    const { container } = render(
      <AgentWorkRow blocks={BLOCKS} running={false} thinkingMs={4000} />
    )

    fireEvent.click(screen.getByRole('button'))

    const names = [...container.querySelectorAll('.ai-assist-tool-call')].map(
      node => node.textContent
    )
    expect(names).to.have.length(2)
    expect(names[0]).to.contain('read_file')
    expect(names[1]).to.contain('list_references')
  })

  it('shows a live status while running', function () {
    render(
      <AgentWorkRow
        blocks={[
          {
            type: 'tool_call' as const,
            call: { id: '1', name: 'read_file', args: { path: 'main.tex' } },
          },
        ]}
        running
      />
    )

    expect(screen.getByText(/Reading main\.tex/)).to.exist
  })
})
```

- [ ] **Step 2: Run to see them fail**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="AgentWorkRow" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
import { useState } from 'react'
import { Sparkle } from '@phosphor-icons/react'
import { AssistantBlock } from '../../agent/agent-messages'
import { ToolCallCard } from './tool-call-card'
import { ThinkingBlock } from './thinking-block'

const RUNNING_LABELS: Record<string, (args: any) => string> = {
  read_file: args => `Reading ${args?.path ?? 'a file'}…`,
  search_project: args => `Searching for ${args?.query ?? '…'}…`,
  list_references: () => 'Checking references…',
  outline_project: () => 'Reading the outline…',
  list_files: () => 'Listing files…',
  get_compile_log: () => 'Reading the compile log…',
  edit_file: args => `Preparing an edit to ${args?.path ?? 'a file'}…`,
}

/**
 * Thinking and tool calls, collapsed into one row.
 *
 * The panel this renders into is a compile log entry: a narrow column already
 * carrying an explainer, one entry per error, and a raw log section. Rendering
 * a row per tool call would triple the entry's height, so the timeline lives
 * behind a single summary and the chevron sits at the end of the text.
 */
export default function AgentWorkRow({
  blocks,
  running,
  thinkingMs,
}: {
  blocks: AssistantBlock[]
  running: boolean
  thinkingMs?: number
}) {
  const [expanded, setExpanded] = useState(false)

  const calls = blocks.filter(block => block.type === 'tool_call')
  const hasThinking = blocks.some(
    block => block.type === 'thinking' && block.thinking.trim().length > 0
  )

  if (calls.length === 0 && !hasThinking) return null

  if (running) {
    const latest = calls.at(-1)
    const label = latest
      ? (RUNNING_LABELS[latest.call.name] ?? (() => 'Working…'))(latest.call.args)
      : 'Finding a fix…'
    return (
      <div className="ai-assist-work-row is-running">
        <span className="ai-finding-fix-dot" aria-hidden="true" />
        <span>{label}</span>
      </div>
    )
  }

  const summary = [
    thinkingMs ? `Thought for ${Math.round(thinkingMs / 1000)}s` : null,
    calls.length ? `${calls.length} tool${calls.length === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="ai-assist-work-row">
      <button
        type="button"
        className="ai-assist-work-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(current => !current)}
      >
        <Sparkle size={13} weight="fill" aria-hidden="true" />
        <span className="ai-assist-work-label">{summary}</span>
        <svg
          className={`ai-thinking-chevron ${expanded ? 'is-expanded' : ''}`}
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 4 10 8 6 12" />
        </svg>
      </button>

      {expanded && (
        <div className="ai-assist-work-timeline">
          {blocks.map((block, index) =>
            block.type === 'thinking' ? (
              <ThinkingBlock
                key={index}
                thinking={block.thinking}
                elapsedMs={block.elapsedMs}
              />
            ) : block.type === 'tool_call' ? (
              <ToolCallCard key={index} call={block.call} />
            ) : null
          )}
        </div>
      )}
    </div>
  )
}
```

Check `ToolCallCard` and `ThinkingBlock`'s real prop names before wiring them; adapt these call sites to match rather than changing those components.

- [ ] **Step 4: Run the tests**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="AgentWorkRow" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS, all three.

- [ ] **Step 5: Verify no commit**

```
git status --short
```

---

## Task 10: Rewrite SuggestFixPanel

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/suggest-fix-panel.tsx`
- Modify: `modules/ai-assist/test/frontend/js/components/suggest-fix-panel.test.tsx`

**Interfaces:**
- Consumes: `useAgentRun` (Task 6), `buildFixTranscript` / `FIX_TOOLS` / `FIX_MAX_STEPS` (Task 8), `AgentWorkRow` (Task 9), `EditApprovalCard` (Task 5).

- [ ] **Step 1: Write the failing tests**

Rewrite `suggest-fix-panel.test.tsx`. Every render now wraps in `EditorProviders`, because the panel consumes React contexts for the first time.

```tsx
import { expect } from 'chai'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EditorProviders } from '../../../../../../test/frontend/helpers/editor-providers'
import SuggestFixPanel from '../../../../frontend/js/features/ai-assist/components/suggest-fix-panel'

const LOG_ENTRY = {
  key: 'entry-1',
  file: 'chapter3.tex',
  line: 87,
  level: 'error',
  message: 'Undefined control sequence',
  raw: 'l.87 \\includegraphics',
}

function open() {
  window.dispatchEvent(
    new CustomEvent('aiAssist:suggestFix', { detail: { entryId: 'entry-1' } })
  )
}

function renderPanel() {
  return render(
    <EditorProviders>
      <SuggestFixPanel logEntry={LOG_ENTRY} />
    </EditorProviders>
  )
}

describe('SuggestFixPanel on the agent harness', function () {
  // setMeta and the stored-provider setup carry over from the previous version
  // of this file; keep them.

  it('renders the explanation as markdown, not as literal backticks', async function () {
    // Stub the provider to stream: "Add `\\usepackage{graphicx}` to the preamble."
    renderPanel()
    open()

    await waitFor(() => {
      expect(screen.getByText('\\usepackage{graphicx}').tagName).to.equal('CODE')
    })
  })

  it('collapses the investigation into one row that expands in order', async function () {
    // Stub the provider to emit read_file then list_references, then text.
    const { container } = renderPanel()
    open()

    await waitFor(() => expect(screen.getByText(/2 tools/)).to.exist)
    fireEvent.click(screen.getByText(/2 tools/).closest('button')!)

    const names = [...container.querySelectorAll('.ai-assist-tool-call')].map(
      node => node.textContent
    )
    expect(names[0]).to.contain('read_file')
    expect(names[1]).to.contain('list_references')
  })

  it('renders a pending approval card for an edit_file call', async function () {
    // Stub the provider to emit an edit_file tool call.
    const { container } = renderPanel()
    open()

    await waitFor(() => {
      expect(container.querySelector('.ai-assist-edit-approval')).to.exist
      expect(container.querySelector('.diff-line-ins')).to.exist
    })
  })

  it('collapses a decided edit to a one-line receipt', async function () {
    const { container } = renderPanel()
    open()

    await waitFor(() => expect(screen.getByText(/Accept/)).to.exist)
    fireEvent.click(screen.getByText(/Accept/))

    await waitFor(() => {
      expect(screen.getByText(/applied/)).to.exist
      expect(container.querySelectorAll('.diff-line')).to.have.length(0)
    })
  })

  it('explains itself when it runs out of steps', async function () {
    // Stub the provider to emit six tool calls and never conclude.
    renderPanel()
    open()

    await waitFor(() => {
      expect(screen.getByText(/could not pin this down/i)).to.exist
    })
  })
})
```

- [ ] **Step 2: Run to see them fail**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="SuggestFixPanel on the agent harness" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Rewrite the panel. It keeps: the `enabled` meta check, `entryId` matching, open/closed state, the `aiAssist:suggestFix` and `aiAssist:suggestDone` events, the `ERROR_MESSAGES` map (minus `badRequest`, plus `contextExhausted`), and the footer with its disclaimer, thumbs and retry.

It drops: `useFixStream`, `parseFixBlock`, `applyFix`, `docLines`, `lastRequestRef`, and the `aiAssist:documentSnapshot` listener.

Core wiring:

```tsx
const {
  state,
  running,
  error,
  handle,
  approvalContext,
  run,
  stop,
  onDecision,
  needsConsent,
  allowConsent,
} = useAgentRun({ tools: FIX_TOOLS, maxSteps: FIX_MAX_STEPS })

const startRun = useCallback(async () => {
  const compile = handle.lastCompile()
  const others = [
    ...(compile?.errors ?? []).map(e => ({
      level: 'error',
      file: e.file,
      line: e.line,
    })),
    ...(compile?.warnings ?? []).map(w => ({
      level: 'warning',
      file: w.file,
      line: w.line,
    })),
    // The clicked entry is in this list too; drop it so it is not indexed
    // against itself.
  ].filter(entry => !(entry.file === logEntry?.file && entry.line === logEntry?.line))

  const transcript = await buildFixTranscript({
    handle,
    focused: {
      level: logEntry?.level ?? 'error',
      message: logEntry?.message ?? '',
      raw: logEntry?.raw ?? null,
      file: logEntry?.file ?? null,
      line: logEntry?.line ?? null,
    },
    others,
  })

  await run(transcript)
}, [handle, logEntry, run])
```

Render, top to bottom:

```tsx
<AgentWorkRow
  blocks={lastAssistant?.blocks ?? []}
  running={running}
  thinkingMs={lastAssistant?.thinkingElapsedMs}
/>

<MarkdownContent content={lastAssistant?.text ?? ''} />

{decidedEdits.map(edit => (
  <div className="ai-assist-edit-receipt" key={edit.id}>
    {edit.path}:{edit.startLine} {edit.accepted ? '✓ applied' : '✗ rejected'}
  </div>
))}

{pendingEdit && approvalContext && (
  <EditApprovalCard
    edit={pendingEdit}
    startLine={approvalContext.startLine}
    onDecision={decision => {
      recordDecision(pendingEdit, decision)
      onDecision(decision)
    }}
  />
)}
```

Accept and Reject live in the existing footer action row, in the slot where "Apply suggestion" used to be — do not add a second action row.

When `state.stoppedForBudget` is true, render below the explanation:

```tsx
<p className="ai-suggest-budget-note">
  I could not pin this down within my step budget. Try again, or ask in the AI
  assistant panel for a longer look.
</p>
```

- [ ] **Step 4: Run the tests**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --grep="SuggestFixPanel on the agent harness" \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend
```

Expected: PASS, all five.

- [ ] **Step 5: Check the height budget**

Render the panel in the browser (Task 12 deploys it) with a run that made four tool calls and one edit. Count the rows: work row, explanation, one diff, footer. If the steady-state card is materially taller than the pre-change card, the collapse is not working and this task is not done.

- [ ] **Step 6: Verify no commit**

```
git status --short
```

---

## Task 11: Delete the retired stack

**Files:**
- Delete: `error-prompt.ts`, `hooks/use-fix-stream.ts`, `parse-fix-block.ts`, `apply-fix.ts`
- Delete: `test/frontend/js/error-prompt.test.ts`, `test/frontend/js/parse-fix-block.test.ts`, `test/frontend/js/apply-fix.test.ts`
- Modify: `assistant.ts`, `components/apply-fix-listener.tsx`

- [ ] **Step 1: Confirm nothing still imports them**

```
cd overleaf/services/web
grep -rn "error-prompt\|use-fix-stream\|parse-fix-block\|from '../apply-fix'\|explainError" modules/ai-assist --include="*.ts" --include="*.tsx"
```

Expected: only the files about to be deleted, and `apply-fix-listener.tsx`. If anything else appears, Task 10 is incomplete — go back rather than deleting under it.

- [ ] **Step 2: Delete the files**

```
cd overleaf/services/web/modules/ai-assist
rm frontend/js/features/ai-assist/error-prompt.ts
rm frontend/js/features/ai-assist/hooks/use-fix-stream.ts
rm frontend/js/features/ai-assist/parse-fix-block.ts
rm frontend/js/features/ai-assist/apply-fix.ts
rm test/frontend/js/error-prompt.test.ts
rm test/frontend/js/parse-fix-block.test.ts
rm test/frontend/js/apply-fix.test.ts
```

- [ ] **Step 3: Strip `explainError`**

In `assistant.ts`, delete the `explainError` generator and the now-unused imports of `buildErrorPrompt` and `LogEntryInput`. `MAX_OUTPUT_TOKENS` stays if `test()` still uses it; check before removing.

- [ ] **Step 4: Trim the listener**

In `apply-fix-listener.tsx`, remove the `aiAssist:applyFix` and `aiAssist:documentSnapshot` handlers, the `snapshotRef` document-snapshot map, and the imports of `hasDrifted`, `applyFixToView`, `lineRangeToOffsets` and `ParsedFix`.

Keep every agent bridge listener: `agentApplyEdit`, `agentApplyEditResult`, `agentReadDoc`, `agentReadDocResult`, `agentReadSelection`, `agentSelection`, `agentCursor`, and `selectionChanged`. The rail and the rewritten panel both depend on them.

Drift detection is now anchor matching inside `proposeEdit`, not snapshot comparison, so the snapshot map has no remaining purpose.

- [ ] **Step 5: Run everything**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend 2>&1 | tail -30
```

Expected: pass/fail counts at or better than the Task 1 baseline, minus the tests deliberately deleted here.

- [ ] **Step 6: Confirm the wiring test still passes**

```
cd overleaf/services/web
npx vitest run modules/ai-assist/test/unit --reporter=verbose 2>&1 | grep -i "core wiring" -A 20
```

Expected: PASS. `CoreWiring.test.mjs` is a vitest file, not mocha — it is never reached by the mocha command used elsewhere in this task. The four slot paths are unchanged; `apply-fix-listener.tsx` still exists and is still registered in `sourceEditorComponents`.

- [ ] **Step 7: Verify no commit**

```
git status --short
```

Expected: deletions show as ` D` and modifications as ` M`, all unstaged. No commit was made.

---

# Phase 4 — Verify

## Task 12: Full verification and dev server

- [ ] **Step 1: Typecheck**

```
cd overleaf/services/web
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "modules/ai-assist" | head -20
```

Expected: no errors in `modules/ai-assist`. Pre-existing errors elsewhere are not this change's problem.

- [ ] **Step 2: Lint the changed files**

```
cd overleaf/services/web
npx eslint modules/ai-assist --ext .ts,.tsx 2>&1 | tail -20
```

- [ ] **Step 3: Full frontend suite against the baseline**

```
cd overleaf/services/web
NODE_ENV=test TZ=GMT npx mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' \
  --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  modules/ai-assist/test/frontend 2>&1 | tail -30
```

Compare against Task 1's recorded baseline. Investigate any new failure; do not accept "it was probably already failing" without checking the baseline note.

- [ ] **Step 4: Module unit tests**

```
cd overleaf/services/web
npx vitest run modules/ai-assist/test/unit 2>&1 | tail -20
```

Expected: PASS, including `CoreWiring.test.mjs`.

- [ ] **Step 5: Redeploy the dev server**

Rebuild and restart the dev server for this worktree so the change can actually be looked at. Use the worktree-named compose project and the port already allocated to the `ai-assist` worktree; do not take port 80 if another worktree's server holds it.

Then check it by hand, because the point of this work is a UI that fits:

1. Open a project, introduce a typo in a `\usepackage` line, compile.
2. Click Suggest fix on the resulting error.
3. Confirm: the work row is one line; expanding it shows the tool calls in order with the chevron at the end; the explanation renders backticked commands as code; the diff has gutters and word-level highlighting; Accept and Reject sit in the existing footer row.
4. Confirm the card is not materially taller than it was before this change.
5. Introduce a missing-package error in an `\input`-ed chapter file and confirm the fix targets the preamble in the root document — this is the case the old implementation could not express at all.

- [ ] **Step 6: Report**

Tell the user the dev server URL and port, what changed, and anything found by hand in Step 5 that the tests did not catch.

- [ ] **Step 7: Final state check**

```
cd /home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist
git status --short
git diff --stat
```

Expected: all work present as uncommitted working-tree changes. **No commit at any point in this plan.**

---

## Self-Review Notes

Checked against the spec:

- §1 task block → Task 8 (`FIX_TASK_BLOCK`)
- §2 compile-error envelope → Task 7
- §3 fix-run → Task 8
- §4 useAgentRun + agent-state move → Tasks 2 and 6
- §5 approval start line → Task 3
- §6 UI, vertical budget → Tasks 4, 9, 10
- Deletions → Task 11
- Risk 1 (contexts) → Task 1, which gates everything
- Risk 3 (refactor risk) → Tasks 2, 3, 5, 6 all land before the panel is touched, each gated on the rail's suite

Type consistency: `startLine` is the name used in Tasks 3, 4, 5, 6 and 10. `FocusedLogEntry` and `LogIndexEntry` are defined in Task 7 and consumed in Tasks 8 and 10. `AgentState` is defined in Task 2 and consumed in Task 6.
