# AI Assist Starter Harness & Context Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Part 2 of the spec: make starter suggestions track project changes dynamically without freezing, surface duplicate label errors, wrap concrete starters in a one-shot task harness, add the document outline to the `<project-context>` envelope, and add the reference integrity audit tool.

**Architecture:** 
- `useProjectStarters` updates dynamically whenever `ProjectIndex.hash` or compile status/counts change, replacing the single-shot `settledRef` with a cache-key comparison that preserves zero-blink loading.
- `Starter` derives `oneShot: boolean` (true for concrete derived rules, false for generic fallbacks). `oneShot` starters wrap prompts in `<task reply="chat">`, and `fix-run` wraps in `<task reply="none">`.
- `SYSTEM_PROMPT` updates to document both `<task reply="none">` and `<task reply="chat">`.
- `<project-context>` envelope adds a compact `<outline>` block (up to 40 section titles and ranges) delta-encoded against `outlineFingerprint`.
- `fix_duplicate_labels` rule (priority 87) detects `index.references.duplicateLabels`.
- "Advanced tools" adds a reference integrity audit starter.

**Tech Stack:** TypeScript, React, Mocha + Chai + Sinon, `@testing-library/react`, `esprima` (translation extractor parser).

**Spec:** `overleaf/docs/superpowers/specs/2026-09-14-ai-assist-tool-surface-and-starter-harness-design.md` (Part 2)

## Global Constraints

- **Never run `git commit`, `git push`, or any history-altering git command.** Leave all changes in the working tree uncommitted.
- **Working directory for commands:** `overleaf/services/web` inside the `ai-assist` worktree.
- **Test command:**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit \
    --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js \
    --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
    --reporter dot modules/ai-assist/test/frontend
  ```
- **Baseline:** exactly 7 pre-existing failures on this branch. Keep all new tests passing and no new failures.
- **Translation constraint:** `agent-empty-state.tsx` uses literal string keys in `t(...)` calls because `yarn extract-translations` parses statically with esprima.

---

### Task 1: `fix_duplicate_labels` starter rule & localization

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/starters/derive-starters.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-empty-state.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/starters/derive-starters.test.ts`

**Interfaces:**
- Consumes: `index.references.duplicateLabels` from `agent/context/references.ts`.
- Produces: `StarterRuleId` includes `'fix_duplicate_labels'`; priority 87; params `{ count: number }`.

- [ ] **Step 1: Write the failing test**

Append to `modules/ai-assist/test/frontend/js/agent/starters/derive-starters.test.ts`:

```ts
  it('derives fix_duplicate_labels when references contain duplicate labels', function () {
    const signals: any = {
      index: {
        rootPath: 'main.tex',
        references: {
          duplicateLabels: ['fig:plot', 'sec:intro'],
          refs: [],
          citations: [],
          labels: [],
          bibKeys: [],
        },
        outline: { sections: [], hasTitle: true },
        packages: [],
        files: [],
      },
      files: [{ path: 'main.tex', type: 'doc' }],
      lastCompile: { status: 'success', errors: [], warnings: [] },
      openFile: null,
    }

    const starters = deriveStarters(signals)
    const dupStarter = starters.find(s => s.id === 'fix_duplicate_labels')
    expect(dupStarter).to.exist
    expect(dupStarter!.priority).to.equal(87)
    expect(dupStarter!.params.count).to.equal(2)
    expect(dupStarter!.prompt).to.include('duplicate')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension ts --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/starters/derive-starters.test.ts 2>&1`
Expected: FAIL (starter not found).

- [ ] **Step 3: Implement `fix_duplicate_labels` rule**

In `derive-starters.ts`:
1. Add `'fix_duplicate_labels'` to `StarterRuleId` union.
2. In `RULES` array, insert between `add_missing_bib_entries` (88) and `resolve_broken_refs` (85):

```ts
  // Duplicate \label definitions make \ref silently point to the wrong location.
  ({ index }) => {
    if (!index) return null
    const dups = index.references?.duplicateLabels ?? []
    if (dups.length === 0) return null
    const keys = [...new Set(dups)]
    return {
      id: 'fix_duplicate_labels',
      params: { count: keys.length },
      prompt: `Fix ${keys.length} duplicate \\label definition${keys.length > 1 ? 's' : ''} in this project (${joinKeys(keys)}). Each \\label must be unique so cross-references resolve to the intended target. Update duplicate labels and their corresponding \\ref calls.`,
      priority: 87,
    }
  },
```

In `agent-empty-state.tsx`:
Add case to `labelFor(starter)`:

```ts
      case 'fix_duplicate_labels':
        return t('ai_assist_starter_fix_duplicate_labels', {
          count: Number(params.count),
          defaultValue: `Fix ${params.count} duplicate labels`,
        })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension ts --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/starters/derive-starters.test.ts 2>&1`
Expected: PASS.

---

### Task 2: Per-starter `oneShot` flag

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/starters/derive-starters.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/starters/derive-starters.test.ts`

**Interfaces:**
- Consumes: `Starter` type.
- Produces: `Starter.oneShot: boolean` (true for derived rules, false for fallbacks).

- [ ] **Step 1: Write the failing test**

Append to `modules/ai-assist/test/frontend/js/agent/starters/derive-starters.test.ts`:

```ts
  it('marks derived starters as oneShot: true and fallbacks as oneShot: false', function () {
    const signals: any = {
      index: null,
      files: [{ path: 'main.tex', type: 'doc' }],
      lastCompile: {
        status: 'failure',
        errors: [{ message: 'err', file: 'main.tex', line: 1 }],
        warnings: [],
      },
      openFile: null,
    }

    const starters = deriveStarters(signals)
    const errStarter = starters.find(s => s.id === 'fix_compile_errors')
    expect(errStarter!.oneShot).to.equal(true)

    const fallbackStarter = starters.find(s => s.priority === 0)
    if (fallbackStarter) {
      expect(fallbackStarter.oneShot).to.equal(false)
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension ts --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/starters/derive-starters.test.ts 2>&1`
Expected: FAIL (`oneShot` undefined).

- [ ] **Step 3: Implement `oneShot` in `derive-starters.ts`**

In `derive-starters.ts`:
1. In `export type Starter = { ... }`, add:
```ts
  /**
   * True for concrete project-derived rules, false for open-ended fallbacks.
   * One-shot starters wrap their prompt in a task block so the model acts
   * immediately rather than conversing.
   */
  oneShot: boolean
```
2. In `deriveStarters`:
When pushing from `fired`:
```ts
  for (const rule of RULES) {
    const starter = rule(signals)
    if (starter) fired.push({ ...starter, oneShot: true })
  }
```
When pushing from `availableFallbacks`:
```ts
    picked.push({
      id: fallback.id,
      params: {},
      prompt: fallback.prompt,
      priority: 0,
      oneShot: false,
    })
```

- [ ] **Step 4: Run tests to verify it passes**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension ts --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/starters/derive-starters.test.ts 2>&1`
Expected: PASS.

---

### Task 3: Dynamic recomputation in `useProjectStarters`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/starters/use-project-starters.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/starters/use-project-starters.test.ts` (create or update)

**Interfaces:**
- Consumes: `handle.lastCompile()`, `handle.index()`, `handle.listFiles()`.
- Produces: `useProjectStarters` returns recomputed starters when compile status/counts or index hash change.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/starters/use-project-starters.test.tsx`:

```tsx
import { expect } from 'chai'
import { renderHook, act, waitFor } from '@testing-library/react'
import customLocalStorage from '@/infrastructure/local-storage'
import { useProjectStarters } from '../../../../../frontend/js/features/ai-assist/agent/starters/use-project-starters'
import { createFakeHandle } from '../helpers/fake-handle'

describe('useProjectStarters recomputation', function () {
  beforeEach(function () {
    customLocalStorage.clear()
  })

  it('updates starters when compile outcome changes without requiring a new chat refresh', async function () {
    let compileState: any = {
      status: 'failure',
      errors: [{ message: 'err', file: 'main.tex', line: 1 }],
      warnings: [],
    }

    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'x' },
      lastCompile: compileState,
    })
    handle.lastCompile = () => compileState

    const { result, rerender } = renderHook(
      ({ seed }) =>
        useProjectStarters({
          handle,
          files: [{ path: 'main.tex', type: 'doc' }],
          projectId: 'p1',
          refreshSeed: seed,
        }),
      { initialProps: { seed: 0 } }
    )

    await waitFor(() => {
      expect(result.current.some(s => s.id === 'fix_compile_errors')).to.equal(true)
    })

    // Now compile passes cleanly
    compileState = { status: 'success', errors: [], warnings: [] }

    rerender({ seed: 0 })

    await waitFor(() => {
      expect(result.current.some(s => s.id === 'fix_compile_errors')).to.equal(false)
    })
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/starters/use-project-starters.test.tsx 2>&1`
Expected: FAIL (starters do not update because `settledRef` blocks recomputation).

- [ ] **Step 3: Implement dynamic cache-key comparison in `useProjectStarters`**

In `use-project-starters.ts`:
Replace `settledRef` with `lastComputedKeyRef = useRef<string | null>(null)`:

```ts
  const lastCompile = handle?.lastCompile?.() ?? null
  const compileKey = lastCompile
    ? `${lastCompile.status}:${lastCompile.errors.length}:${lastCompile.warnings.length}`
    : 'no-compile'

  const lastKeyRef = useRef<string | null>(null)
  const lastSeedRef = useRef(refreshSeed)

  useEffect(() => {
    let mounted = true
    const isNewChatRefresh = lastSeedRef.current !== refreshSeed
    lastSeedRef.current = refreshSeed

    const computeAndSave = async () => {
      try {
        const [loadedFiles, loadedIndex] = await Promise.all([
          files && files.length > 0
            ? Promise.resolve(files)
            : handle?.listFiles?.().catch(() => []) ?? Promise.resolve([]),
          handle?.index?.().catch(() => null) ?? Promise.resolve(null),
        ])

        if (!mounted) return

        const currentKey = `${projectId}:${refreshSeed}:${compileKey}:${loadedIndex?.hash ?? ''}`
        if (lastKeyRef.current === currentKey && !isNewChatRefresh) {
          return
        }

        const result = deriveStarters(
          {
            index: loadedIndex,
            files: loadedFiles,
            lastCompile: handle?.lastCompile?.() ?? null,
            openFile: handle?.openFile?.() ?? null,
          },
          { shuffle: isNewChatRefresh }
        )

        lastKeyRef.current = currentKey
        setStarters(result)
        customLocalStorage.setItem(keyFor(projectId), result)
      } catch {
        // Retain existing starters on error
      }
    }

    computeAndSave()

    return () => {
      mounted = false
    }
  }, [handle, files, projectId, refreshSeed, compileKey])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/starters/use-project-starters.test.tsx 2>&1`
Expected: PASS.

---

### Task 4: `<task reply="none|chat">` task block builder & system prompt

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/fix-run.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/starters/starter-task.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/system-prompt.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/starters/starter-task.test.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/fix-run.test.ts`

**Interfaces:**
- Produces: `buildStarterTaskBlock(prompt: string): string` generating `<task reply="chat">...`. `buildFixTaskBlock` in `fix-run.ts` emits `<task reply="none">...`.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/starters/starter-task.test.ts`:

```ts
import { expect } from 'chai'
import { buildStarterTaskBlock } from '../../../../frontend/js/features/ai-assist/agent/starters/starter-task'

describe('buildStarterTaskBlock', function () {
  it('emits a task block with reply="chat"', function () {
    const text = buildStarterTaskBlock('Add graphicx to preamble')
    expect(text).to.include('<task reply="chat">')
    expect(text).to.include('Add graphicx to preamble')
    expect(text).to.include('</task>')
    expect(text).to.match(/finish the whole job/i)
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension ts --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/starters/starter-task.test.ts 2>&1`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `starter-task.ts` & update `fix-run.ts` and `system-prompt.ts`**

Create `modules/ai-assist/frontend/js/features/ai-assist/agent/starters/starter-task.ts`:

```ts
/**
 * Wraps a concrete starter suggestion into a one-shot task block.
 *
 * Distinct from the compile-error panel's `reply="none"`: the user has a reply
 * box in the chat, but clicked a concrete task expecting it to be executed,
 * not discussed. If ambiguous, the model may ask a clarifying question, but
 * only after performing all unambiguous steps.
 */
export function buildStarterTaskBlock(prompt: string): string {
  return [
    '<task reply="chat">',
    prompt,
    '',
    'Finish the whole job in this run. Do not end by offering to do the work,',
    'and make no drive-by changes. You may ask a question if genuinely ambiguous,',
    'but only after completing all unambiguous work first.',
    '</task>',
  ].join('\n')
}
```

In `fix-run.ts`:
Update `buildFixTaskBlock`:
Change `<task>` to `<task reply="none">`.

In `system-prompt.ts`:
Update the `# One-click tasks` section to explain both variants:

```ts
  '# One-click tasks',
  '',
  'A turn carrying a <task> block came from a button or starter, not a typed message:',
  '',
  '- `<task reply="none">`: from a panel with no reply box. Nobody can answer',
  '  you, and you run on a short step budget. Spend steps on tools, never on talk.',
  '  No text before or between tool calls, no question of any kind, no promise to',
  '  act next turn. Finish in this run: the explanation and the edit, or the exact',
  '  change you recommend and why you made none.',
  '- `<task reply="chat">`: from a starter suggestion in the main assistant panel.',
  '  The user has a reply box, but clicked a concrete task expecting it to be',
  '  done, not discussed. Finish the whole job in this run; never end by offering',
  '  to do the work you were asked to do. A question earns its place only when the',
  '  task is genuinely ambiguous and cannot be resolved from the document itself,',
  '  and only after doing everything unambiguous first.',
  '',
  'Where the task block specifies an output shape, that shape wins over every',
  'general rule in this prompt, including the ones below.',
```

- [ ] **Step 4: Run tests**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension ts --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/starters/starter-task.test.ts modules/ai-assist/test/frontend/js/agent/fix-run.test.ts modules/ai-assist/test/frontend/js/agent/system-prompt.test.ts 2>&1`
Expected: PASS.

---

### Task 5: Starter execution with one-shot task harness in chat

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-empty-state.tsx`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/components/starter-execution.test.tsx`

**Interfaces:**
- Consumes: `Starter.oneShot`, `buildStarterTaskBlock`.
- Produces: Clicking a `oneShot: true` starter sends the prompt wrapped in `buildStarterTaskBlock`. Clicking a `oneShot: false` starter sends the raw prompt.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/components/starter-execution.test.tsx`:

```tsx
import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, fireEvent } from '@testing-library/react'
import { AgentEmptyState } from '../../../../../frontend/js/features/ai-assist/components/agent/agent-empty-state'
import { createFakeHandle } from '../helpers/fake-handle'

describe('AgentEmptyState starter clicks', function () {
  it('hands the starter object to onPick so the caller can apply the task harness', function () {
    const onPick = sinon.stub()
    const { handle } = createFakeHandle()

    render(
      <AgentEmptyState
        onPick={onPick}
        handle={handle}
        files={[{ path: 'main.tex', type: 'doc' }]}
      />
    )

    const buttons = screen.getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])

    expect(onPick.calledOnce).to.equal(true)
    const arg = onPick.firstCall.args[0]
    expect(arg).to.be.an('object')
    expect(arg).to.have.property('prompt')
    expect(arg).to.have.property('oneShot')
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/components/starter-execution.test.tsx 2>&1`
Expected: FAIL (`arg` is string, not object).

- [ ] **Step 3: Update `AgentEmptyState` and `AgentPanel`**

In `agent-empty-state.tsx`:
Change `onPick` prop signature:
```ts
onPick: (starter: { prompt: string; oneShot?: boolean }) => void
```
For advanced tools:
`onClick={() => onPick({ prompt: tool.prompt, oneShot: true })}`
For starters:
`onClick={() => onPick(starter)}`

In `agent-panel.tsx`:
Import `buildStarterTaskBlock`:
```ts
import { buildStarterTaskBlock } from '../../agent/starters/starter-task'
```
Update empty state handler:
```ts
  const onPickStarter = useCallback(
    (picked: { prompt: string; oneShot?: boolean }) => {
      const text = picked.oneShot
        ? buildStarterTaskBlock(picked.prompt)
        : picked.prompt
      void onSend(text)
    },
    [onSend]
  )
```
Pass `onPick={onPickStarter}` to `<AgentEmptyState />`.

- [ ] **Step 4: Run tests**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/components/starter-execution.test.tsx 2>&1`
Expected: PASS.

---

### Task 6: Compact outline in `<project-context>` envelope

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/types.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/escape.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/project-context.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx:60-75`
- Test: `modules/ai-assist/test/frontend/js/context/envelope-outline.test.ts`

**Interfaces:**
- Consumes: `ContextSnapshot.outline?: Outline | null`.
- Produces: `<outline>` section in `<project-context>`, delta-encoded against `outlineFingerprint`, capped at 40 entries with overflow note. Omitted when empty.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/context/envelope-outline.test.ts`:

```ts
import { expect } from 'chai'
import { renderEnvelope } from '../../../../frontend/js/features/ai-assist/agent/context/project-context'
import { ContextSnapshot } from '../../../../frontend/js/features/ai-assist/agent/context/types'

const BASE_SNAPSHOT: ContextSnapshot = {
  rootDocPath: 'main.tex',
  files: [{ path: 'main.tex', type: 'doc', lines: 10 }],
  openFile: null,
  selection: null,
  compile: null,
}

describe('renderEnvelope outline section', function () {
  it('renders section hierarchy with line ranges in the envelope', function () {
    const snapshot: ContextSnapshot = {
      ...BASE_SNAPSHOT,
      outline: {
        documentClass: 'article',
        packages: [],
        hasTitle: true,
        includes: [],
        notes: [],
        sections: [
          { path: 'main.tex', line: 5, level: 1, title: 'Introduction', numbered: true },
          { path: 'main.tex', line: 15, level: 2, title: 'Background', numbered: true },
        ],
      },
    }

    const { text, state } = renderEnvelope({
      snapshot,
      attachments: [],
      turn: 1,
      previous: null,
    })

    expect(text).to.include('<outline>')
    expect(text).to.include('main.tex:5 Introduction')
    expect(text).to.include('main.tex:15 Background')
    expect(text).to.include('</outline>')
    expect(state.outlineFingerprint).to.be.a('string')
  })

  it('delta-encodes unchanged outline on subsequent turn', function () {
    const snapshot: ContextSnapshot = {
      ...BASE_SNAPSHOT,
      outline: {
        documentClass: 'article',
        packages: [],
        hasTitle: true,
        includes: [],
        notes: [],
        sections: [
          { path: 'main.tex', line: 5, level: 1, title: 'Introduction', numbered: true },
        ],
      },
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

    expect(second.text).to.include('<outline>unchanged since turn 1</outline>')
  })

  it('omits outline block completely when project has no sections', function () {
    const snapshot: ContextSnapshot = {
      ...BASE_SNAPSHOT,
      outline: null,
    }

    const { text } = renderEnvelope({
      snapshot,
      attachments: [],
      turn: 1,
      previous: null,
    })

    expect(text).to.not.include('<outline>')
  })

  it('caps at 40 sections and renders an overflow count', function () {
    const sections = Array.from({ length: 45 }, (_, i) => ({
      path: 'main.tex',
      line: i * 10,
      level: 1,
      title: `Section ${i + 1}`,
      numbered: true,
    }))

    const snapshot: ContextSnapshot = {
      ...BASE_SNAPSHOT,
      outline: {
        documentClass: 'article',
        packages: [],
        hasTitle: true,
        includes: [],
        notes: [],
        sections,
      },
    }

    const { text } = renderEnvelope({
      snapshot,
      attachments: [],
      turn: 1,
      previous: null,
    })

    expect(text).to.include('Section 40')
    expect(text).to.not.include('Section 41')
    expect(text).to.include('(+5 more sections)')
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension ts --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/envelope-outline.test.ts 2>&1`
Expected: FAIL (no outline in envelope).

- [ ] **Step 3: Implement outline rendering in envelope**

1. In `types.ts`:
Add `outline?: Outline | null` to `ContextSnapshot` (import `Outline` from `./outline`).
Add `outlineFingerprint?: string` to `EnvelopeState`.

2. In `escape.ts`:
Add `'outline'` to `ENVELOPE_CLOSING_TAGS`.

3. In `project-context.ts`:
Add `renderOutline`:

```ts
const MAX_OUTLINE_SECTIONS = 40

function renderOutline(snapshot: ContextSnapshot, previous: EnvelopeState | null) {
  const sections = snapshot.outline?.sections ?? []
  if (sections.length === 0) return null

  const fingerprint = sections
    .map(s => `${s.path}:${s.line}:${s.level}:${s.title}`)
    .join('|')

  if (previous?.outlineFingerprint === fingerprint) {
    return {
      text: `<outline>unchanged since turn ${previous.turn}</outline>`,
      fingerprint,
    }
  }

  const shown = sections.slice(0, MAX_OUTLINE_SECTIONS)
  const overflow = sections.length - shown.length
  const lines = shown.map(
    s => `${'  '.repeat(Math.max(0, s.level - 1))}${neutraliseClosingTags(s.path)}:${s.line} ${neutraliseClosingTags(s.title)}`
  )
  if (overflow > 0) {
    lines.push(`  (+${overflow} more sections)`)
  }

  return {
    text: ['<outline>', ...lines, '</outline>'].join('\n'),
    fingerprint,
  }
}
```

In `renderEnvelope`:
```ts
  const files = renderFiles(snapshot, previous)
  const outline = renderOutline(snapshot, previous)

  const sections: string[] = [files.text]
  if (outline) sections.push(outline.text)
  sections.push(renderCompile(snapshot))
...
  return {
    text: [
      `<project-context turn="${turn}">`,
      ...sections,
      '</project-context>',
    ].join('\n'),
    state: {
      turn,
      filesFingerprint: files.fingerprint,
      ...(outline ? { outlineFingerprint: outline.fingerprint } : {}),
    },
  }
```

4. In `agent-panel.tsx`:
In `buildUserEntry`:
```ts
    const index = await handle.index().catch(() => null)
    const snapshot: ContextSnapshot = {
      rootDocPath: handle.rootDocPath(),
      files: await handle.listFiles(),
      openFile: handle.openFile(),
      selection: activeSel,
      outline: index?.outline ?? null,
      compile: compile ...
```

- [ ] **Step 4: Run tests**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension ts --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/context/envelope-outline.test.ts 2>&1`
Expected: PASS.

---

### Task 7: Reference-integrity audit in "Advanced tools" & final verification

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-empty-state.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/components/starter-execution.test.tsx`

- [ ] **Step 1: Write test for advanced tools**

Append to `modules/ai-assist/test/frontend/js/agent/components/starter-execution.test.tsx`:

```tsx
  it('renders both advanced tools: unsupported statements and reference integrity audit', function () {
    const { handle } = createFakeHandle()
    render(
      <AgentEmptyState
        onPick={() => {}}
        handle={handle}
        files={[{ path: 'main.tex', type: 'doc' }]}
      />
    )

    expect(screen.getByText(/Scan for unsupported statements/i)).to.exist
    expect(screen.getByText(/Audit cross-references and citations/i)).to.exist
  })
```

- [ ] **Step 2: Run test to verify failure**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/components/starter-execution.test.tsx 2>&1`
Expected: FAIL (audit tool not found).

- [ ] **Step 3: Add audit tool to `advancedTools`**

In `agent-empty-state.tsx`:
Import `Bookmarks` or `LinkBreak` icon from `@phosphor-icons/react`.
Add to `advancedTools` array:

```tsx
    {
      id: 'audit-reference-integrity',
      title: t(
        'ai_assist_tool_audit_references',
        'Audit cross-references and citations'
      ),
      description: t(
        'ai_assist_tool_audit_references_description',
        'Check for duplicate labels, unresolved cross-references, and missing bibliography entries.'
      ),
      icon: <Bookmarks size={18} weight="fill" className="ai-assist-empty-state-icon" />,
      prompt:
        'Run an audit of this project\'s references: call get_references to find any duplicate labels, unresolved \\ref calls, or missing bibliography entries, and suggest the exact fixes.',
    },
```

- [ ] **Step 4: Run tests and full verification suite**

Run:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  --reporter dot modules/ai-assist/test/frontend

../../node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep modules/ai-assist
../../node_modules/.bin/eslint modules/ai-assist/frontend modules/ai-assist/test
```
Expected: 620+ passing, 7 baseline failures, zero new type errors, zero ESLint errors.
Check Webpack docker logs for successful compilation.
