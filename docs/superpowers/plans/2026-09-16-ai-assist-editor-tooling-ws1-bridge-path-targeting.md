# AI Assist Editor Tooling WS1: Editor Bridge & Path-Targeted Document Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate cross-document corruption and active-tab bleed by guaranteeing that all editor bridge reads, edits, and file creations strictly target the requested file path, await asynchronous document switching in CodeMirror, recursively create parent directories, and distinguish bridge timeouts from document content drift.

**Architecture:** 
1. **Target-Aware Bridge Handshake:** Extend `readDocOverBridge` and `applyEditOverBridge` in `use-project-handle.ts` and `ApplyFixListener` in `apply-fix-listener.tsx` to exchange normalized `path` and `docId` parameters. If the currently mounted CodeMirror view does not match the requested document, `ApplyFixListener` immediately rejects the read/edit with `pathMismatch` / `docIdMismatch` rather than mutating or reading whatever unrelated tab is open.
2. **Awaited Editor Document Switching:** When `proposeEdit` or `createFile` targets a document that is not currently active, `useProjectHandle` awaits `openDocWithId(docId)` to allow CodeMirror to mount the target buffer before dispatching the bridge mutation. If the target document is not active during initial matching, content is read directly from `projectSnapshot` rather than querying the active editor bridge.
3. **Recursive Folder Resolution in `createFile`:** Replace the naive single-level `folderIdForPath` fallback with an asynchronous `ensureFolderPath` resolver that recursively checks the file tree and creates missing intermediate directories via `syncCreateEntity(projectId, parentFolderId, { endpoint: 'folder', name })`.
4. **Initial File Population Isolation:** Decouple `create_file` from the active document view. After creating the entity on the server and awaiting `openDoc(createdDoc)` from `useEditorManagerContext()`, initial content is populated into the newly created document only after verified mount, with zero line-1 injection into the previously active document. (Note: `openDoc(createdDoc)` must be used rather than `openDocWithId(docId)` because `syncCreateEntity` does not synchronously update React's `fileTreeData` state, causing `findDocEntityById` inside `openDocWithId` to return null).
5. **Discrete Status Classification:** Separate infrastructure lag from real document drift. When `applyEditOverBridge` hits its 5-second timeout or encounters a document mismatch, it resolves `{ status: 'timeout' }` or `{ status: 'error' }` instead of collapsing into `{ status: 'drifted' }`.

**Tech Stack:** TypeScript, React, CodeMirror 6, Mocha, Chai, Sinon, `@testing-library/react`.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-16-ai-assist-editor-tooling-redesign-design.md` (Workstream 1)

---

## Global Constraints

- **Never run `git commit`, `git push`, or any history-altering git command.** This repository requires explicit per-command user approval for all git writes. Leave every change uncommitted in the working tree. Verification steps replace commit steps. This overrides any instruction from sub-skills telling you to commit.
- **Working directory for all commands:** `overleaf/services/web` inside the `ai-assist` worktree:
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Frontend test runner (Mocha — NOT Vitest):**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha \
    --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
    --require test/frontend/bootstrap.js \
    <path_to_test>
  ```
- **Backend test runner (Vitest — NOT Mocha):**
  ```bash
  NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
  ```
- **TRAP: Broken yarn in sandbox:** `yarn` is broken in the sandboxed shell. Always invoke test binaries directly from `../../node_modules/.bin/mocha` or `../../node_modules/.bin/vitest`.
- **Baseline passing counts (verified clean 2026-09-16):**
  - Frontend Mocha suite (`modules/ai-assist/test/frontend`): **774 passing, 0 failing**.
  - Backend Vitest suite (`modules/ai-assist/test/unit/src`): **10 test files, 107 passing**.
  - TRAP: The wider web unit suite has ~57 pre-existing failures on clean main. Scope all test runs to `modules/ai-assist/`.
- **Feature flag gate:** Feature remains default-disabled behind `getMeta('ol-aiAssistEnabled')`.
- **Engineered Harness Over Workaround Prompts:** Fixes must be engineered into the tools, event handlers, and lifecycle hooks — never by adding workaround instructions or retry pleas to system prompts.
- **No REST wrappers for AI provider calls; no instance-wide default provider.**

---

## Verified Source Files & Line Numbers

| File (Absolute Path) | Verified Lines | Purpose in WS1 |
|---|---|---|
| `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts` | 21-27 | Extend `EditOutcome` union with `{ status: 'timeout' }` and `{ status: 'error' }` |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts` | 135-155, 185-215 | Handle `timeout` and `error` statuses in `editFileTool.execute` |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/create-file.ts` | 60-75 | Handle `timeout` and `error` statuses in `createFileTool.execute` |
| `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx` | 33-118 | Add path & docId verification to `onAgentReadDoc` and `onAgentApplyEdit` |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts` | 182-249, 485-535, 586-624 | Implement `ensureFolderPath`, target-aware `readDocOverBridge`, `applyEditOverBridge`, awaited `openDocWithId` in `proposeEdit` and `openDoc` in `createFile` |

---

## Audit Corrections & Design Decisions

1. **Awaiting `openDocWithId` vs Pure Snapshot Mutation:**
   - *Audit Suggestion:* Some synthesis notes suggested applying edits to background files purely through project snapshot mutations or backend document APIs without switching tabs.
   - *Codebase Investigation & Decision:* In Overleaf's architecture, client-side mutations must go through the active CodeMirror EditorView (`view.dispatch()`) to integrate with the real-time operational transformation (OT) WebSocket engine, maintain user undo/redo history stacks, and trigger live collaborative cursor updates. Direct backend mutation while a user is actively in the project creates out-of-sync document snapshot collisions. Therefore, the correct architecture is:
     1. In `proposeEdit`, check if the target document is active.
     2. If not active, read the text from `projectSnapshot` to compute anchors safely without active-tab bleed.
     3. Request user approval.
     4. Upon approval, await `openDocWithId(docId)` so CodeMirror cleanly mounts the target document.
     5. Dispatch `applyEditOverBridge` with `path` and `docId` validation.
2. **Intermediate Directory Creation in `createFile`:**
   - *Audit Finding #27 Correction:* `folderIdForPath` in `use-project-handle.ts:182-193` was a synchronous lookup returning `null` whenever an intermediate folder did not already exist. It defaulted to `fileTreeData._id` (root folder). The fix implements an asynchronous `ensureFolderPath` that calls `syncCreateEntity(projectId, parentFolderId, { endpoint: 'folder', name })` sequentially for each path segment.
3. **Distinguishing Timeout from Drift:**
   - *Audit Finding #26 Correction:* In `use-project-handle.ts:245`, `applyEditOverBridge`'s `setTimeout` previously resolved `{ status: 'drifted' }`. This misled the LLM into believing the user had edited the file during turn execution. It now resolves `{ status: 'timeout', message: 'Editor bridge timed out waiting for editor response.' }`.

---

## Tasks

### Task 1: Extend `EditOutcome` and Tool Handlers with `timeout` and `error` Statuses

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/create-file.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/create-file-tool.test.ts`

- [ ] **Step 1: Write failing tests in `edit-tool.test.ts` and `create-file-tool.test.ts`**

In `modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts`, add test cases for `timeout` and `error` statuses:

```typescript
it('reports a timeout status with an actionable message', async function () {
  const { handle } = createFakeHandle({
    docs: DOCS,
    onEdit: () => ({ status: 'timeout', message: 'Editor bridge timed out.' }),
  })

  const result: any = await TOOLS.edit_file.execute(
    { path: 'unique.tex', oldText: 'two', newText: 'TWO' },
    handle
  )

  expect(result.status).to.equal('timeout')
  expect(result.message).to.match(/timed out/i)
})

it('reports an error status without collapsing to drifted', async function () {
  const { handle } = createFakeHandle({
    docs: DOCS,
    onEdit: () => ({ status: 'error', message: 'Document mismatch.' }),
  })

  const result: any = await TOOLS.edit_file.execute(
    { path: 'unique.tex', oldText: 'two', newText: 'TWO' },
    handle
  )

  expect(result.status).to.equal('error')
  expect(result.message).to.include('Document mismatch.')
})
```

In `modules/ai-assist/test/frontend/js/agent/create-file-tool.test.ts`, add test cases:

```typescript
it('reports a timeout when creating a file', async function () {
  const { handle } = createFakeHandle({
    docs: DOCS,
    onCreate: () => ({ status: 'timeout', message: 'Bridge timed out.' }),
  })

  const result: any = await createFileTool.execute(
    { path: 'new.tex', content: 'content' },
    handle
  )

  expect(result.status).to.equal('timeout')
  expect(result.message).to.match(/timed out/i)
})

it('reports an error when entity creation fails', async function () {
  const { handle } = createFakeHandle({
    docs: DOCS,
    onCreate: () => ({ status: 'error', message: 'Failed to create folder.' }),
  })

  const result: any = await createFileTool.execute(
    { path: 'sections/new.tex', content: 'content' },
    handle
  )

  expect(result.status).to.equal('error')
  expect(result.message).to.include('Failed to create folder.')
})
```

- [ ] **Step 2: Run tests to verify failure**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts modules/ai-assist/test/frontend/js/agent/create-file-tool.test.ts
```

- [ ] **Step 3: Update `project-handle.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts`, find lines 21-27:

```typescript
// CURRENT CODE:
export type EditOutcome =
  | { status: 'applied'; startLine?: number }
  | { status: 'rejected'; note?: string }
  | { status: 'noMatch' }
  | { status: 'ambiguous'; matches: number }
  | { status: 'drifted' }
```

Replace with:

```typescript
export type EditOutcome =
  | { status: 'applied'; startLine?: number }
  | { status: 'rejected'; note?: string }
  | { status: 'noMatch'; message?: string }
  | { status: 'ambiguous'; matches: number; message?: string }
  | { status: 'drifted'; message?: string }
  | { status: 'timeout'; message?: string }
  | { status: 'error'; message?: string }
```

- [ ] **Step 4: Update `edit-file.ts` and `create-file.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts`, update the `switch (outcome.status)` blocks (both append mode and regular replace mode) to handle `timeout` and `error`:

```typescript
        case 'drifted':
          return {
            status: 'drifted',
            message: `${path} changed while the user was reviewing. Re-read it before trying again.`,
          }
        case 'timeout':
          return {
            status: 'timeout',
            message:
              outcome.message ||
              `The editor bridge timed out while attempting to edit ${path}. The editor may be busy or unmounted. Please retry.`,
          }
        case 'error':
          return {
            status: 'error',
            message:
              outcome.message ||
              `An error occurred while communicating with the editor for ${path}.`,
          }
        default:
          return outcome
```

In `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/create-file.ts`, update `createFileTool.execute`:

```typescript
    switch (outcome.status) {
      case 'applied':
        return {
          status: 'applied',
          message: `Created ${path}.`,
          startLine: (outcome as any).startLine ?? 1,
        }
      case 'rejected': {
        const userNote = outcome.note ? ` with note: "${outcome.note}"` : ''
        return {
          status: 'rejected',
          note: outcome.note,
          message: `The user rejected creating ${path}${userNote}. Do not attempt to create the same file again in this turn. Acknowledge the rejection, address their feedback, and explain alternatives or ask how they would like to proceed.`,
        }
      }
      case 'timeout':
        return {
          status: 'timeout',
          message:
            outcome.message ||
            `The editor bridge timed out while creating ${path}. Please retry.`,
        }
      case 'error':
        return {
          status: 'error',
          message:
            outcome.message ||
            `An error occurred while creating ${path}.`,
        }
      default:
        return outcome
    }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts modules/ai-assist/test/frontend/js/agent/create-file-tool.test.ts
```

---

### Task 2: Implement Path & DocId Target Verification in `ApplyFixListener`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx`
- Create: `modules/ai-assist/test/frontend/js/agent/apply-fix-listener.test.tsx`

**The Defects & Traps:**
1. **Uncaught Context Error in Tests:** `ApplyFixListenerInner` calls `useCodeMirrorViewContext()`, which throws unconditionally if rendered outside `<CodeMirrorViewContext.Provider>`. `EditorProviders` does not provide `CodeMirrorViewContext`. The test must wrap the tree in `<CodeMirrorViewContext.Provider value={view}>` with an `EditorView` instance.
2. **Basename vs Full Path Mismatch:** `openDocName` in `useEditorOpenDocContext` stores only the document basename (e.g. `intro.tex`), NOT the full repo-relative path (e.g. `sections/intro.tex`). To support nested files, `ApplyFixListener` must resolve the full relative path using `pathInFolder(fileTreeData, currentDocumentId) ?? openDocName`.
3. **Empty/Null Path Guard Bypass:** If `currentPath` is falsy (e.g. initial load or unmounted document), checking `if (requestedPath && currentPath && requestedPath !== currentPath)` evaluates to false, bypassing the mismatch guard. The check must be `if (requestedPath && (!currentPath || requestedPath !== currentPath))`.

- [ ] **Step 1: Write test suite in `apply-fix-listener.test.tsx`**

Create `modules/ai-assist/test/frontend/js/agent/apply-fix-listener.test.tsx`:

```tsx
import { expect } from 'chai'
import React from 'react'
import { render, act } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { CodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import ApplyFixListener from '../../../../frontend/js/features/ai-assist/components/apply-fix-listener'
import { EditorProviders } from '../../../../../../test/frontend/helpers/editor-providers'
import { resetMeta, setMeta } from '../../../../../../test/frontend/helpers/reset-meta'

describe('ApplyFixListener path and document target verification', function () {
  let view: EditorView

  beforeEach(function () {
    resetMeta()
    setMeta('ol-aiAssistEnabled', true)
    setMeta('ol-showAiFeatures', true)
    view = new EditorView({
      doc: 'line 1\nline 2\nline 3\n',
    })
  })

  afterEach(function () {
    view?.destroy()
  })

  it('responds with document text when requested path matches active document', async function () {
    let result: any = null
    const onResult = (e: Event) => {
      result = (e as CustomEvent).detail
    }
    window.addEventListener('aiAssist:agentReadDocResult', onResult)

    render(
      <CodeMirrorViewContext.Provider value={view}>
        <EditorProviders>
          <ApplyFixListener />
        </EditorProviders>
      </CodeMirrorViewContext.Provider>
    )

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentReadDoc', {
          detail: { path: 'main.tex' },
        })
      )
    })

    window.removeEventListener('aiAssist:agentReadDocResult', onResult)
    expect(result).to.not.equal(null)
    expect(result.text).to.be.a('string')
    expect(result.error).to.equal(undefined)
  })

  it('responds with null text and pathMismatch error when requested path differs from active document', async function () {
    let result: any = null
    const onResult = (e: Event) => {
      result = (e as CustomEvent).detail
    }
    window.addEventListener('aiAssist:agentReadDocResult', onResult)

    render(
      <CodeMirrorViewContext.Provider value={view}>
        <EditorProviders>
          <ApplyFixListener />
        </EditorProviders>
      </CodeMirrorViewContext.Provider>
    )

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentReadDoc', {
          detail: { path: 'chapters/intro.tex' },
        })
      )
    })

    window.removeEventListener('aiAssist:agentReadDocResult', onResult)
    expect(result).to.not.equal(null)
    expect(result.text).to.equal(null)
    expect(result.error).to.equal('pathMismatch')
  })

  it('rejects agentApplyEdit with pathMismatch when target path does not match active editor document', async function () {
    let result: any = null
    const onResult = (e: Event) => {
      result = (e as CustomEvent).detail
    }
    window.addEventListener('aiAssist:agentApplyEditResult', onResult)

    render(
      <CodeMirrorViewContext.Provider value={view}>
        <EditorProviders>
          <ApplyFixListener />
        </EditorProviders>
      </CodeMirrorViewContext.Provider>
    )

    act(() => {
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentApplyEdit', {
          detail: {
            path: 'chapters/intro.tex',
            from: 1,
            to: 1,
            oldText: 'something',
            replacement: 'replacement',
          },
        })
      )
    })

    window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
    expect(result).to.not.equal(null)
    expect(result.status).to.equal('pathMismatch')
    expect(result.message).to.match(/does not match target path/i)
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/apply-fix-listener.test.tsx
```

- [ ] **Step 3: Update `apply-fix-listener.tsx`**

In `modules/ai-assist/frontend/js/features/ai-assist/components/apply-fix-listener.tsx`:

```tsx
import { useCallback, useEffect } from 'react'
import { useCodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { useFileTreeData } from '@/shared/context/file-tree-data-context'
import { pathInFolder } from '@/features/file-tree/util/path'
import useEventListener from '@/shared/hooks/use-event-listener'
import getMeta from '@/utils/meta'

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

function normalizePath(path: string | null | undefined): string {
  if (!path) return ''
  return path.replace(/^\//, '')
}

function ApplyFixListenerInner() {
  const view = useCodeMirrorViewContext()
  const { openDocName, currentDocumentId } = useEditorOpenDocContext()
  const { fileTreeData } = useFileTreeData()

  // Full repo-relative path (e.g. 'sections/intro.tex') resolved via fileTreeData, falling back to openDocName
  const currentPath = normalizePath(
    (currentDocumentId && fileTreeData ? pathInFolder(fileTreeData, currentDocumentId) : null) ?? openDocName
  )

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
        const path = currentPath || 'main.tex'
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
  }, [view, currentPath])

  const onAgentReadDoc = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; docId?: string }> | undefined)?.detail
      const requestedPath = normalizePath(detail?.path)
      const requestedDocId = detail?.docId

      if (requestedPath && (!currentPath || requestedPath !== currentPath)) {
        return window.dispatchEvent(
          new CustomEvent('aiAssist:agentReadDocResult', {
            detail: {
              text: null,
              path: currentPath,
              docId: currentDocumentId,
              error: 'pathMismatch',
            },
          })
        )
      }

      if (requestedDocId && (!currentDocumentId || requestedDocId !== currentDocumentId)) {
        return window.dispatchEvent(
          new CustomEvent('aiAssist:agentReadDocResult', {
            detail: {
              text: null,
              path: currentPath,
              docId: currentDocumentId,
              error: 'docIdMismatch',
            },
          })
        )
      }

      window.dispatchEvent(
        new CustomEvent('aiAssist:agentReadDocResult', {
          detail: {
            text: view.state.doc.toString(),
            path: currentPath,
            docId: currentDocumentId,
          },
        })
      )
    },
    [view, currentPath, currentDocumentId]
  )

  const onAgentApplyEdit = useCallback(
    (event: Event) => {
      const { path, docId, from, to, oldText, replacement } =
        (event as CustomEvent<any>).detail ?? {}

      const respond = (status: string, message?: string) =>
        window.dispatchEvent(
          new CustomEvent('aiAssist:agentApplyEditResult', { detail: { status, message } })
        )

      const requestedPath = normalizePath(path)

      if (requestedPath && (!currentPath || requestedPath !== currentPath)) {
        return respond(
          'pathMismatch',
          `Active editor document "${currentPath}" does not match target path "${requestedPath}".`
        )
      }

      if (docId && (!currentDocumentId || docId !== currentDocumentId)) {
        return respond(
          'docIdMismatch',
          `Active editor document ID "${currentDocumentId}" does not match target ID "${docId}".`
        )
      }

      const current = view.state.doc.toString().split('\n')

      // The user may have typed since the diff was rendered. Compare against the
      // anchor the model matched, not a stale snapshot.
      if (current.slice(from - 1, to).join('\n') !== oldText) {
        return respond('drifted', 'Document content drifted before edit could be applied.')
      }

      const offsets = lineRangeToOffsets(view.state.doc, from, to)
      if (!offsets) {
        return respond('drifted', 'Line range out of document bounds.')
      }

      view.dispatch({
        changes: { from: offsets.from, to: offsets.to, insert: replacement },
      })
      respond('applied')
    },
    [view, currentPath, currentDocumentId]
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
      if (typeof text !== "string" || !view) return

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/apply-fix-listener.test.tsx
```

---

### Task 3: Fix Target-Aware `readDocOverBridge`, `applyEditOverBridge`, and `proposeEdit`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Modify: `modules/ai-assist/test/frontend/js/agent/handle-context.test.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/handle-context.test.ts`

**The Defects & Traps:**
1. `readDocOverBridge()` sent no detail, causing `apply-fix-listener.tsx` to read the active document buffer regardless of `edit.path`.
2. `proposeEdit` matched anchors against whatever document was open, computed line numbers relative to the active document, and dispatched edits to `main.tex`.
3. `openDocWithId` was called without `await` on line 518, racing the bridge dispatch.
4. Bridge timeouts (line 245) resolved `{ status: 'drifted' }`.
5. **TRAP: `openFile` declaration hoisting:** In `use-project-handle.ts`, `openFile` is declared on line 559, after `proposeEdit` (line 485). Referencing `openFile()` inside `proposeEdit` before its declaration produces TS2448 ("Block-scoped variable 'openFile' used before its declaration") and a runtime Temporal Dead Zone ReferenceError. `openFile` must be declared *before* `proposeEdit`.
6. **TRAP: `handle-context.test.ts` `proposeEdit` with `notes.tex`:** In `modules/ai-assist/test/frontend/js/agent/handle-context.test.ts:160-176`, the existing test `'tells the approver which line the edit starts on'` calls `proposeEdit` with `path: 'notes.tex'` against `FakeEditorBridge`. `EditorProviders` defaults to `main.tex` as the open document. With target-aware checks, `isTargetOpen` evaluates to `false` for `notes.tex`, skipping `readDocOverBridge` and returning `{ status: 'noMatch' }` before reaching `requestApproval`, breaking the test. `handle-context.test.ts` must be updated to target `main.tex` to match the open editor document in `EditorProviders`.

- [ ] **Step 1: Write failing unit tests in `editor-bridge.test.ts` and update `handle-context.test.ts`**

In `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts`, add bridge and target tests:

```typescript
describe('bridge event payload and timeout handling', function () {
  it('passes target path in agentReadDoc and receives text', async function () {
    const onRead = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.path === 'sections/ch1.tex') {
        window.dispatchEvent(
          new CustomEvent('aiAssist:agentReadDocResult', {
            detail: { text: 'chapter one content' },
          })
        )
      } else {
        window.dispatchEvent(
          new CustomEvent('aiAssist:agentReadDocResult', {
            detail: { text: null, error: 'pathMismatch' },
          })
        )
      }
    }
    window.addEventListener('aiAssist:agentReadDoc', onRead)

    // Verify through window dispatch
    const readPromise = new Promise(resolve => {
      const onRes = (e: Event) => {
        window.removeEventListener('aiAssist:agentReadDocResult', onRes)
        resolve((e as CustomEvent).detail)
      }
      window.addEventListener('aiAssist:agentReadDocResult', onRes)
      window.dispatchEvent(
        new CustomEvent('aiAssist:agentReadDoc', {
          detail: { path: 'sections/ch1.tex' },
        })
      )
    })

    const res: any = await readPromise
    window.removeEventListener('aiAssist:agentReadDoc', onRead)
    expect(res.text).to.equal('chapter one content')
  })
})
```

In `modules/ai-assist/test/frontend/js/agent/handle-context.test.ts:160-182`, update target path from `'notes.tex'` to `'main.tex'` (matching the active document mounted by `EditorProviders`):

```typescript
    const outcome = await handle!.proposeEdit({
      path: 'main.tex',
      oldText: 'line two',
      newText: 'line 2',
    })

    expect(requestApproval).to.have.been.calledOnce
    expect(requestApproval.firstCall.args[1]).to.deep.equal({ startLine: 2 })
    expect(outcome.status).to.equal('rejected')
```

- [ ] **Step 2: Update `readDocOverBridge` and `applyEditOverBridge` in `use-project-handle.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`:

Find lines 212-249:

```typescript
// CURRENT CODE:
function readDocOverBridge(timeoutMs = REPLY_TIMEOUT_MS): Promise<string | null> {
  return new Promise(resolve => {
    let resolved = false
    let timer: any
    const onResult = (event: Event) => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentReadDocResult', onResult)
      if (timer) clearTimeout(timer)
      resolve((event as CustomEvent)?.detail?.text ?? null)
    }
    window.addEventListener('aiAssist:agentReadDocResult', onResult)
    timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentReadDocResult', onResult)
      resolve(null)
    }, timeoutMs)
    window.dispatchEvent(new CustomEvent('aiAssist:agentReadDoc'))
  })
}

function applyEditOverBridge(
  detail: { from: number; to: number; oldText: string; replacement: string },
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
      resolve({ status: 'drifted' })
    }, timeoutMs)
    window.dispatchEvent(new CustomEvent('aiAssist:agentApplyEdit', { detail }))
  })
}
```

Replace with:

```typescript
export function readDocOverBridge(
  targetPath?: string,
  docId?: string,
  timeoutMs = REPLY_TIMEOUT_MS
): Promise<string | null> {
  return new Promise(resolve => {
    let resolved = false
    let timer: any
    const onResult = (event: Event) => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentReadDocResult', onResult)
      if (timer) clearTimeout(timer)
      const detail = (event as CustomEvent)?.detail
      if (detail?.text === null || detail?.error === 'pathMismatch' || detail?.error === 'docIdMismatch') {
        resolve(null)
      } else {
        resolve(detail?.text ?? null)
      }
    }
    window.addEventListener('aiAssist:agentReadDocResult', onResult)
    timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentReadDocResult', onResult)
      resolve(null)
    }, timeoutMs)
    window.dispatchEvent(
      new CustomEvent('aiAssist:agentReadDoc', {
        detail: { path: targetPath, docId },
      })
    )
  })
}

export function applyEditOverBridge(
  detail: {
    path?: string
    docId?: string
    from: number
    to: number
    oldText: string
    replacement: string
  },
  timeoutMs = REPLY_TIMEOUT_MS
): Promise<{
  status: 'applied' | 'drifted' | 'pathMismatch' | 'docIdMismatch' | 'timeout' | 'error'
  message?: string
}> {
  return new Promise(resolve => {
    let resolved = false
    let timer: any
    const onResult = (event: Event) => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
      if (timer) clearTimeout(timer)
      const result = (event as CustomEvent)?.detail
      if (result && typeof result.status === 'string') {
        resolve(result)
      } else {
        resolve({
          status: 'error',
          message: 'Malformed response from editor bridge.',
        })
      }
    }
    window.addEventListener('aiAssist:agentApplyEditResult', onResult)
    timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      window.removeEventListener('aiAssist:agentApplyEditResult', onResult)
      resolve({
        status: 'timeout',
        message: 'Editor bridge timed out waiting for editor response.',
      })
    }, timeoutMs)
    window.dispatchEvent(new CustomEvent('aiAssist:agentApplyEdit', { detail }))
  })
}
```

- [ ] **Step 3: Hoist `openFile` and Update `proposeEdit` in `useProjectHandle`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`:

Hoist `openFile` definition before `proposeEdit` and update `proposeEdit`:

```typescript
  const openFile = useCallback((): { path: string; cursorLine: number | null } | null => {
    if (!getCurrentDocumentId || !fileTreeData) return null
    const docId = getCurrentDocumentId()
    if (!docId) return null
    const path = pathInFolder(fileTreeData, docId)
    if (!path) return null
    return { path, cursorLine: cursorLineRef.current }
  }, [getCurrentDocumentId, fileTreeData])

  const proposeEdit = useCallback(
    async (edit: EditRequest): Promise<EditOutcome> => {
      const norm = edit.path.replace(/^\//, '')
      const open = openFile()
      const isTargetOpen = Boolean(open?.path && open.path.replace(/^\//, '') === norm)

      let content: string | null = null
      if (isTargetOpen) {
        content = await readDocOverBridge(norm)
      }

      if (content === null) {
        const docContents =
          projectSnapshot?.getDocContents?.(norm) ??
          projectSnapshot?.getDocContents?.('/' + norm)
        if (typeof docContents === 'string') {
          content = docContents
        } else {
          const docs = (projectSnapshot as any)?.docs ?? {}
          const doc = docs[norm] ?? docs['/' + norm]
          if (!doc) return { status: 'noMatch' }
          const lines = normalizeDoc((doc as any)?.doc?.lines ?? doc)
          content = lines.join('\n')
        }
      }

      const span = findUniqueSpan(content, edit.oldText)
      if (span.status !== 'found') {
        return span
      }

      const { from: startLine } = spanToLineRange(content, span.index, edit.oldText.length)

      const approval = await requestApproval(edit, { startLine })
      if (!approval.accepted) {
        return { status: 'rejected', note: approval.note }
      }

      let targetDocId: string | undefined
      if (fileTreeData) {
        const entity = findEntityByPath(fileTreeData, norm)
        if (entity?.type === 'doc') {
          targetDocId = entity.entity._id
          if (!isTargetOpen && openDocWithId) {
            await openDocWithId(targetDocId)
          }
        }
      }

      const { to: endLine } = spanToLineRange(content, span.index + edit.oldText.length, 0)
      const applied = await applyEditOverBridge({
        path: norm,
        docId: targetDocId,
        from: startLine,
        to: endLine,
        oldText: edit.oldText,
        replacement: edit.newText,
      })

      if (applied.status === 'applied') {
        return { status: 'applied', startLine }
      }
      if (applied.status === 'timeout') {
        return {
          status: 'timeout',
          message: applied.message || 'Editor bridge timed out waiting for editor response.',
        }
      }
      if (applied.status === 'pathMismatch' || applied.status === 'docIdMismatch') {
        return {
          status: 'error',
          message: applied.message || 'Editor document mismatch during edit application.',
        }
      }
      if (applied.status === 'drifted') {
        return { status: 'drifted', message: applied.message }
      }
      return {
        status: 'error',
        message: applied.message || 'Failed to apply edit over bridge.',
      }
    },
    [projectSnapshot, fileTreeData, openDocWithId, openFile, requestApproval]
  )
```
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts modules/ai-assist/test/frontend/js/agent/handle-context.test.ts
```

---

### Task 4: Implement Recursive Intermediate Directory Creation and Non-Bleeding `createFile`

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/create-file-tool.test.ts`

**The Defects & Traps:**
1. Finding #27: `folderIdForPath` silently dropped intermediate missing directories and fell back to root folder `fileTreeData._id`, creating files in root instead of nested folders.
2. Finding #3 / #20: `createFile` applied content via line-1 bridge replacement against the open active document tab (`main.tex`), corrupting the active tab.
3. **TRAP: Existing tests depend on `folderIdForPath`:** `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts:4, 150-185` directly imports and tests `folderIdForPath` from `use-project-handle.ts`. Retain the exported `folderIdForPath` function in `use-project-handle.ts` alongside `ensureFolderPath` so existing tests continue to compile and pass without regression.
4. **TRAP: Asynchronous React `fileTreeData` update in `createFile`:** `syncCreateEntity` creates the entity via backend HTTP request. The local React `fileTreeData` state is NOT updated synchronously with the newly created document. Calling `openDocWithId(createdDoc._id)` relies on `findDocEntityById(fileTreeData, docId)`, which returns undefined because the doc is not yet present in React `fileTreeData`, silently failing to switch active documents and causing the subsequent `applyEditOverBridge` to fail with `pathMismatch`. Therefore, `useProjectHandle` must destructure `openDoc` from `useEditorManagerContext()` and call `await openDoc(createdDoc)` directly, which accepts the returned `Doc` object without performing a file tree lookup.

- [ ] **Step 1: Add unit tests for `ensureFolderPath` in `editor-bridge.test.ts`**

In `modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts`, add test suite for `ensureFolderPath`:

```typescript
import { ensureFolderPath } from '../../../../frontend/js/features/ai-assist/agent/use-project-handle'

describe('ensureFolderPath recursive folder creation', function () {
  it('returns root folder id when segments is empty', async function () {
    const root: any = { _id: 'root-1', folders: [] }
    const id = await ensureFolderPath('p-1', root, [])
    expect(id).to.equal('root-1')
  })

  it('navigates existing folders without calling entity creation', async function () {
    const root: any = {
      _id: 'root-1',
      folders: [
        {
          _id: 'f-sections',
          name: 'sections',
          folders: [{ _id: 'f-sub', name: 'sub', folders: [] }],
        },
      ],
    }
    const id = await ensureFolderPath('p-1', root, ['sections', 'sub'])
    expect(id).to.equal('f-sub')
  })
})
```

- [ ] **Step 2: Implement `ensureFolderPath` and update `createFile` in `use-project-handle.ts`**

In `modules/ai-assist/frontend/js/features/ai-assist/agent/use-project-handle.ts`:

Retain `folderIdForPath` and add `ensureFolderPath` helper:

```typescript
export function folderIdForPath(root: Folder, segments: string[]): string | null {
  if (!root) return null
  if (!segments || segments.length === 0) return root._id
  let current: Folder | null = root
  for (const part of segments) {
    if (!current?.folders) return null
    const next: Folder | undefined = current.folders.find(f => f.name === part)
    if (!next) return null
    current = next
  }
  return current?._id ?? null
}

export async function ensureFolderPath(
  projectId: string,
  rootFolder: Folder,
  segments: string[]
): Promise<string> {
  if (!segments || segments.length === 0) return rootFolder._id
  let currentFolder = rootFolder
  for (const segment of segments) {
    if (!segment) continue
    const existing: Folder | undefined = currentFolder.folders?.find(f => f.name === segment)
    if (existing) {
      currentFolder = existing
    } else {
      const created = (await syncCreateEntity(projectId, currentFolder._id, {
        endpoint: 'folder',
        name: segment,
      })) as Folder | undefined

      if (!created || !created._id) {
        throw new Error(`Failed to create intermediate folder "${segment}".`)
      }
      const newFolder: Folder = {
        _id: created._id,
        name: segment,
        folders: created.folders ?? [],
        docs: created.docs ?? [],
        fileRefs: created.fileRefs ?? [],
      }
      if (!currentFolder.folders) {
        currentFolder.folders = []
      }
      currentFolder.folders.push(newFolder)
      currentFolder = newFolder
    }
  }
  return currentFolder._id
}
```

In `useProjectHandle`, obtain `openDoc` from `useEditorManagerContext()` and update `createFile`:

```typescript
  const { openDoc, openDocWithId, getCurrentDocumentId } = useEditorManagerContext()
```

```typescript
  const createFile = useCallback(
    async (request: { path: string; content: string }): Promise<EditOutcome> => {
      const approval = await requestApproval(
        { path: request.path, oldText: '', newText: request.content },
        { startLine: 1 }
      )
      if (!approval.accepted) {
        return { status: 'rejected', note: approval.note }
      }

      const norm = request.path.replace(/^\//, '')
      const segments = norm.split('/')
      const fileName = segments.pop()!

      if (!project?._id || !fileTreeData) {
        return { status: 'error', message: 'Project or file tree not loaded.' }
      }

      let parentFolderId: string
      try {
        parentFolderId = await ensureFolderPath(project._id, fileTreeData, segments)
      } catch (err: any) {
        return {
          status: 'error',
          message: err?.message || 'Failed to create parent directories.',
        }
      }

      let createdDoc: any
      try {
        createdDoc = await syncCreateEntity(project._id, parentFolderId, {
          endpoint: 'doc',
          name: fileName,
        })
      } catch (err: any) {
        return {
          status: 'error',
          message: err?.message || `Failed to create file "${request.path}".`,
        }
      }

      if (!createdDoc?._id) {
        return {
          status: 'error',
          message: `Failed to create file entity for "${request.path}".`,
        }
      }

      // If openDoc is available, switch to the newly created document and populate initial content
      if (openDoc) {
        try {
          await openDoc(createdDoc)
          const applied = await applyEditOverBridge({
            path: norm,
            docId: createdDoc._id,
            from: 1,
            to: 1,
            oldText: '',
            replacement: request.content,
          })

          if (applied.status === 'applied') {
            return { status: 'applied', startLine: 1 }
          }
          if (applied.status === 'timeout') {
            return {
              status: 'timeout',
              message:
                applied.message ||
                'Editor bridge timed out populating new file content.',
            }
          }
          if (applied.status === 'pathMismatch' || applied.status === 'docIdMismatch') {
            return {
              status: 'error',
              message:
                applied.message ||
                'Active editor document did not switch to new file.',
            }
          }
          if (applied.status === 'drifted') {
            return { status: 'drifted', message: applied.message }
          }
          return {
            status: 'error',
            message: applied.message || 'Failed to populate content in new file.',
          }
        } catch (err: any) {
          return {
            status: 'error',
            message: err?.message || 'Error opening newly created file.',
          }
        }
      }

      return { status: 'applied', startLine: 1 }
    },
    [fileTreeData, project?._id, openDoc, requestApproval]
  )
```
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/editor-bridge.test.ts modules/ai-assist/test/frontend/js/agent/create-file-tool.test.ts
```

---

### Task 5: Full Regression Testing & Verification

**Files:**
- Run full frontend test suite: `modules/ai-assist/test/frontend`
- Run full backend test suite: `modules/ai-assist/test/unit/src`

- [ ] **Step 1: Run frontend test suite**

```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha \
  --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  modules/ai-assist/test/frontend
```
*Expected count:* **774+ passing, 0 failing**.

- [ ] **Step 2: Run backend test suite**

```bash
NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
```
*Expected count:* **10 test files, 107 passing**.

- [ ] **Step 3: Confirm git status remains uncommitted**

```bash
git status
```
*Verify no git commit or push commands were executed.*

---

## Out of Scope for Workstream 1

- **WS2 (Precision Anchor Resolution):** Character-offset intra-line replacements, append mode (`oldText: ""`) newline slice fixes, newline off-by-one in `spanToLineRange`, blank line window corruption in `findUniqueSpan`, and block deletion primitives are addressed in Workstream 2.
- **WS3 (Robust LaTeX Matching & Schema Ambiguity):** Frontend token-aware LaTeX matching, double-backslash normalization (`\\cmd` -> `\cmd`), line-number prefix stripping (`14: ...`), and `startLine`/`endLine` search scoping are addressed in Workstream 3.
- **WS4 (Compiler Feedback Loop & Delta Tracking):** Asynchronous `startCompile()` synchronization, `logEntriesRef` race resolution, raw TeX log excerpts, error deltas, and `-file-line-error` parser line attribution are addressed in Workstream 4.
- **WS5 (Context Indexing & Harness Hygiene):** `search_text` glob pre-filtering, `get_packages` option retention, `get_outline` bounding, and agent loop tool call ID uniqueness are addressed in Workstream 5.

---

## Verification Commands & Baseline Summary

```bash
# Frontend Mocha Suite (Scope: modules/ai-assist/test/frontend)
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha \
  --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
  --require test/frontend/bootstrap.js \
  modules/ai-assist/test/frontend
# Baseline: >= 774 passing, 0 failing

# Backend Vitest Suite (Scope: modules/ai-assist/test/unit/src)
NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
# Baseline: 10 test files, 107 passing
```
