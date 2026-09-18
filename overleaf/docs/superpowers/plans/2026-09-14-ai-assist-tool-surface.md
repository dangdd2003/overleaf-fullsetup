# AI Assist Tool Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `project_map` god-tool and its inconsistent parameter vocabulary with ten single-purpose tools, and make mutation approval structural rather than per-tool.

**Architecture:** `project_map`'s four `view` modes become four independent tools, each with its own small schema and no mode-conditional parameters. A shared parameter vocabulary (`path` is always exact, `glob` is always a pattern, `limit` is always a cap) is applied across every tool. Mutation safety moves from a per-tool `suspends` flag to a runner-enforced rule: only tools declaring `mutates: true` receive a write-capable `ProjectHandle`, so a tool that forgets to declare it physically cannot write.

**Tech Stack:** TypeScript, React, Mocha + Chai + Sinon, `@testing-library/react`, `fetch-mock`.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-14-ai-assist-tool-surface-and-starter-harness-design.md`

**Scope:** This plan implements **Part 1** of the spec only. Part 2 (the starter harness) is independent per the spec's Sequencing section and gets its own plan.

## Global Constraints

- **Never run `git commit`, `git push`, or any history-altering git command.** This repository requires explicit per-command user approval for all git writes. Leave every change in the working tree. Where the writing-plans template would normally end a task with a commit step, this plan ends it with a verification step instead.
- **Working directory for all commands:** `overleaf/services/web` inside the `ai-assist` worktree.
- **Test command** (substitute a `--grep` when iterating on one test):
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit \
    --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js \
    --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
    --reporter dot modules/ai-assist/test/frontend
  ```
- **Baseline:** the suite has **7 pre-existing failures** on this branch (`reduceAgentEvent`, `findUniqueSpan`, two `useProjectHandle`, three `AgentComposer attachments`). A task is green when the failure count is still 7 and no new name appears. Do not attempt to fix them.
- **Parameter vocabulary, enforced in every tool spec:** `path` is always an exact file path and never a pattern · `glob` is always a pattern · `from`/`to` are always 1-indexed inclusive · `limit` is always a maximum count · `kind` is always a closed enum documented inline.
- **Tool descriptions state what the tool does and when to use it.** No "Not for X — Y does that" clauses; the split removes the ambiguity those existed to patch.
- **All ten tool names, final:** `list_files`, `read_file`, `search_text`, `get_outline`, `get_references`, `get_packages`, `compile_project`, `get_compile_result`, `edit_file`, `create_file`.

---

### Task 1: Add `mutates` to the tool type and a write-capable handle split

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/readonly-handle.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/readonly-handle.test.ts`

**Interfaces:**
- Consumes: `ProjectHandle` from `agent/project-handle.ts`; `AgentTool` from `agent/tools/registry.ts`.
- Produces: `AgentTool.mutates: boolean` (required field); `readOnlyHandle(handle: ProjectHandle): ProjectHandle` which returns a proxy whose `proposeEdit` and `createFile` reject with `Error('This tool is not permitted to modify the project.')`.

**Why this shape:** approval currently happens *inside* `edit_file.execute`, which calls `handle.proposeEdit()`. A tool that writes without calling `proposeEdit` bypasses the user entirely. Gating at the handle makes that impossible rather than merely discouraged.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/readonly-handle.test.ts`:

```ts
import { expect } from 'chai'
import sinon from 'sinon'
import { readOnlyHandle } from '../../../../frontend/js/features/ai-assist/agent/readonly-handle'

function fakeHandle() {
  return {
    listFiles: sinon.stub().resolves([]),
    readFile: sinon.stub().resolves({ lines: [] }),
    proposeEdit: sinon.stub().resolves({ status: 'applied' }),
    createFile: sinon.stub().resolves({ status: 'applied' }),
    rootDocPath: () => 'main.tex',
  } as any
}

describe('readOnlyHandle', function () {
  it('refuses proposeEdit', async function () {
    const inner = fakeHandle()
    try {
      await readOnlyHandle(inner).proposeEdit({
        path: 'a.tex',
        oldText: 'x',
        newText: 'y',
      })
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/not permitted to modify/i)
    }
    expect(inner.proposeEdit.called).to.equal(false)
  })

  it('refuses createFile', async function () {
    const inner = fakeHandle()
    try {
      await readOnlyHandle(inner).createFile('a.tex', 'hi')
      expect.fail('should have thrown')
    } catch (error: any) {
      expect(error.message).to.match(/not permitted to modify/i)
    }
    expect(inner.createFile.called).to.equal(false)
  })

  it('passes reads straight through', async function () {
    const inner = fakeHandle()
    await readOnlyHandle(inner).listFiles()
    expect(inner.listFiles.calledOnce).to.equal(true)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run the test command with `--grep "readOnlyHandle"`.
Expected: failure resolving `agent/readonly-handle`.

- [ ] **Step 3: Implement the handle proxy**

Create `modules/ai-assist/frontend/js/features/ai-assist/agent/readonly-handle.ts`:

```ts
import { ProjectHandle } from './project-handle'

const DENIED = 'This tool is not permitted to modify the project.'

/**
 * A handle with the mutation methods removed.
 *
 * Every write reaches the project through `proposeEdit` or `createFile`, and
 * both put the change in front of the user before it lands. Handing a
 * non-mutating tool a handle where they throw makes "this tool cannot write"
 * a property of the runtime rather than a promise each tool has to keep.
 */
export function readOnlyHandle(handle: ProjectHandle): ProjectHandle {
  return new Proxy(handle, {
    get(target, prop, receiver) {
      if (prop === 'proposeEdit' || prop === 'createFile') {
        return () => Promise.reject(new Error(DENIED))
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}
```

- [ ] **Step 4: Add `mutates` to the tool type**

In `registry.ts`, add to the `AgentTool` type, directly below `suspends`:

```ts
  /**
   * True when the tool can change the project.
   *
   * Distinct from `suspends`, which is about control flow: a tool could pause
   * for a reason other than a write. Only tools declaring this receive a
   * write-capable handle (see `readOnlyHandle`), so forgetting it fails
   * closed.
   */
  mutates: boolean
```

Then set `mutates` on every existing tool: `true` on `editFileTool` and `createFileTool`, `false` on the other five. TypeScript will point at each file that needs it.

- [ ] **Step 5: Run the tests**

Run the full test command.
Expected: `readOnlyHandle` passes; failure count still 7.

- [ ] **Step 6: Verify types**

Run: `../../node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep modules/ai-assist`
Expected: no new errors beyond the four known pre-existing ones (`conversation-store.ts` ×2, `rail-entry.tsx`, `agent-panel.test.tsx` ×3).

---

### Task 2: Enforce the handle split in the runner

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/run-agent.ts:200-215`
- Test: `modules/ai-assist/test/frontend/js/agent/mutation-gate.test.ts`

**Interfaces:**
- Consumes: `readOnlyHandle` from Task 1; `AgentTool.mutates` from Task 1.
- Produces: no new exports. Behavioural guarantee: `runAgent` passes `readOnlyHandle(handle)` to any tool with `mutates: false`, and the unwrapped handle only to `mutates: true` tools.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/mutation-gate.test.ts`:

```ts
import { expect } from 'chai'
import sinon from 'sinon'
import { runAgent } from '../../../../frontend/js/features/ai-assist/agent/run-agent'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'

/** A client that asks for one tool call, then stops. */
function clientCalling(name: string, args: any) {
  return {
    async *streamChat() {
      yield { type: 'tool_call', id: 'c1', name, args }
    },
  } as any
}

function handleStub() {
  return {
    listFiles: sinon.stub().resolves([]),
    readFile: sinon.stub().resolves({ lines: [] }),
    proposeEdit: sinon.stub().resolves({ status: 'applied' }),
    createFile: sinon.stub().resolves({ status: 'applied' }),
    rootDocPath: () => 'main.tex',
    lastCompile: () => null,
  } as any
}

async function drain(gen: AsyncGenerator<any>) {
  const events = []
  for await (const event of gen) events.push(event)
  return events
}

describe('the runner gates mutation on the mutates flag', function () {
  it('hands a non-mutating tool a handle that cannot write', async function () {
    const handle = handleStub()
    const sneaky = {
      spec: { name: 'sneaky', description: 'x', parameters: { type: 'object', properties: {}, required: [] } },
      suspends: false,
      mutates: false,
      async execute(_args: any, given: any) {
        return given.proposeEdit({ path: 'a.tex', oldText: 'x', newText: 'y' })
          .then(() => ({ wrote: true }))
          .catch((error: any) => ({ error: error.message }))
      },
    }

    const events = await drain(
      runAgent({
        client: clientCalling('sneaky', {}) as any,
        handle,
        tools: { sneaky } as any,
        transcript: [{ id: 'u0', role: 'user', text: 'go' }],
      })
    )

    const finished = events.find(e => e.type === 'toolCallFinished')
    expect(finished.result.error).to.match(/not permitted to modify/i)
    expect(handle.proposeEdit.called).to.equal(false)
  })

  it('hands a mutating tool the real handle', async function () {
    const handle = handleStub()
    const writer = {
      spec: { name: 'writer', description: 'x', parameters: { type: 'object', properties: {}, required: [] } },
      suspends: true,
      mutates: true,
      async execute(_args: any, given: any) {
        return given.proposeEdit({ path: 'a.tex', oldText: 'x', newText: 'y' })
      },
    }

    await drain(
      runAgent({
        client: clientCalling('writer', {}) as any,
        handle,
        tools: { writer } as any,
        transcript: [{ id: 'u0', role: 'user', text: 'go' }],
      })
    )

    expect(handle.proposeEdit.calledOnce).to.equal(true)
  })

  it('marks every registry tool that can write', function () {
    // Enumerated so a newly added writing tool is covered without editing
    // this test. proposeEdit/createFile are the only routes to a write.
    for (const [name, tool] of Object.entries(TOOLS)) {
      const writes = /edit_file|create_file/.test(name)
      expect(tool.mutates, `${name}.mutates`).to.equal(writes)
    }
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run the test command with `--grep "gates mutation"`.
Expected: the first test fails — `proposeEdit` succeeds because the raw handle is passed.

- [ ] **Step 3: Implement the gate**

In `run-agent.ts`, replace the `result = await tool.execute(call.args, handle)` line inside the `else` branch (currently around line 210) with:

```ts
        if (tool.suspends) {
          yield { type: 'awaitingApproval', id: call.id, edit: call.args as any }
        }
        try {
          // Only a tool that declares it changes the project gets a handle
          // that can. A tool that forgets the flag hits a rejecting proxy
          // rather than writing behind the user's back.
          const toolHandle = tool.mutates ? handle : readOnlyHandle(handle)
          result = await tool.execute(call.args, toolHandle)
```

Add the import at the top of `run-agent.ts`:

```ts
import { readOnlyHandle } from './readonly-handle'
```

- [ ] **Step 4: Run the tests**

Run the full test command.
Expected: all three new tests pass; failure count still 7.

---

### Task 3: `list_files`

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/list-files.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/list-files-tool.test.ts`

**Interfaces:**
- Consumes: `AgentTool` with `mutates` (Task 1).
- Produces: `listFilesTool: AgentTool`, registered as `list_files`. Result shape `{ files: Array<{ path: string; type: 'doc' | 'binary'; lines?: number }>; truncated?: boolean }` — the same shape `project_map view=files` returns today, so `tool-call-detail.tsx`'s existing `list_files` branch (line 119) already renders it.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/list-files-tool.test.ts`:

```ts
import { expect } from 'chai'
import { listFilesTool } from '../../../../frontend/js/features/ai-assist/agent/tools/list-files'
import { createFakeHandle } from './components/helpers/fake-handle'

describe('list_files', function () {
  it('takes glob, never path, so the vocabulary stays honest', function () {
    const props = listFilesTool.spec.parameters.properties as any
    expect(props).to.have.property('glob')
    expect(props).to.not.have.property('path')
    expect(listFilesTool.spec.parameters.required).to.deep.equal([])
  })

  it('cannot change the project', function () {
    expect(listFilesTool.mutates).to.equal(false)
  })

  it('lists every file when given no glob', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'a', 'sections/intro.tex': 'b' },
    })
    const result: any = await listFilesTool.execute({}, handle)
    expect(result.files.map((f: any) => f.path)).to.have.members([
      'main.tex',
      'sections/intro.tex',
    ])
  })

  it('narrows to the glob when given one', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'a', 'sections/intro.tex': 'b' },
    })
    const result: any = await listFilesTool.execute(
      { glob: 'sections/*.tex' },
      handle
    )
    expect(result.files.map((f: any) => f.path)).to.deep.equal([
      'sections/intro.tex',
    ])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run the test command with `--grep "list_files"`.
Expected: failure resolving `tools/list-files`.

- [ ] **Step 3: Implement by extracting from `project-map.ts`**

Create `tools/list-files.ts`. Move the `view === 'files'` branch of `projectMapTool.execute` and its glob-matching helper out of `project-map.ts` unchanged — only the surrounding spec is new. Do not rewrite the matching logic; it is already correct and tested through `project-map-tool.test.ts`.

```ts
import { AgentTool } from './registry'

export const listFilesTool: AgentTool = {
  spec: {
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
      required: [],
    },
  },
  suspends: false,
  mutates: false,
  async execute({ glob }, handle) {
    // ... moved verbatim from project-map.ts view=files
  },
  render(result) {
    // ... moved verbatim from project-map.ts render, files branch
  },
}
```

- [ ] **Step 4: Register it**

In `registry.ts`, import `listFilesTool` and add `list_files: listFilesTool` to `TOOLS`. Leave `project_map` in place for now; Task 7 removes it once all four splits exist.

- [ ] **Step 5: Run the tests**

Run the full test command.
Expected: the four new tests pass; failure count still 7.

---

### Task 4: `get_outline`

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-outline.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-detail.tsx:154`
- Test: `modules/ai-assist/test/frontend/js/agent/get-outline-tool.test.ts`

**Interfaces:**
- Consumes: `AgentTool` with `mutates` (Task 1).
- Produces: `getOutlineTool: AgentTool`, registered as `get_outline`. Result shape unchanged from `project_map view=outline`: `{ sections: Array<{ title: string; level: number; path: string; from: number; to: number }>; hasTitle: boolean }`.

**Note:** `tool-call-detail.tsx:154` has a dead `outline_project` branch left from an earlier rename. Rename that branch's condition to `get_outline` rather than adding a new one.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/get-outline-tool.test.ts`:

```ts
import { expect } from 'chai'
import { getOutlineTool } from '../../../../frontend/js/features/ai-assist/agent/tools/get-outline'
import { createFakeHandle } from './components/helpers/fake-handle'

describe('get_outline', function () {
  it('has one optional param and no mode discriminator', function () {
    const props = getOutlineTool.spec.parameters.properties as any
    expect(Object.keys(props)).to.deep.equal(['section'])
    expect(getOutlineTool.spec.parameters.required).to.deep.equal([])
    expect(props).to.not.have.property('view')
  })

  it('cannot change the project', function () {
    expect(getOutlineTool.mutates).to.equal(false)
  })

  it('returns sections with the line ranges read_file needs', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex':
          '\\title{T}\n\\section{Intro}\nhello\n\\section{Method}\nworld\n',
      },
    })
    const result: any = await getOutlineTool.execute({}, handle)
    const intro = result.sections.find((s: any) => s.title === 'Intro')
    expect(intro.from).to.be.a('number')
    expect(intro.to).to.be.at.least(intro.from)
  })

  it('narrows to one subtree when given a section', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\section{Intro}\na\n\\section{Method}\nb\n' },
    })
    const result: any = await getOutlineTool.execute(
      { section: 'Method' },
      handle
    )
    expect(result.sections.map((s: any) => s.title)).to.deep.equal(['Method'])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run the test command with `--grep "get_outline"`.
Expected: failure resolving `tools/get-outline`.

- [ ] **Step 3: Implement by extracting from `project-map.ts`**

Create `tools/get-outline.ts` the same way as Task 3: move the `view === 'outline'` execute branch and its render branch out of `project-map.ts` unchanged, wrapped in this spec:

```ts
  spec: {
    name: 'get_outline',
    description:
      'The section tree with each section\'s file and line range, plus the \\input graph. Pass section to get one subtree. Use this before read_file to find where something lives — it costs a fraction of reading the file.',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Return only this section and its subsections',
        },
      },
      required: [],
    },
  },
  suspends: false,
  mutates: false,
```

- [ ] **Step 4: Point the renderer at the new name**

In `tool-call-detail.tsx:154`, change `if (call.name === 'outline_project') {` to `if (call.name === 'get_outline') {`. The body already renders this result shape.

- [ ] **Step 5: Register and run the tests**

Add `get_outline: getOutlineTool` to `TOOLS`. Run the full test command.
Expected: the four new tests pass; failure count still 7.

---

### Task 5: `get_references`

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-references.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-detail.tsx:295`
- Test: `modules/ai-assist/test/frontend/js/agent/get-references-tool.test.ts`

**Interfaces:**
- Consumes: `AgentTool` with `mutates` (Task 1); `References` from `agent/context/references.ts`.
- Produces: `getReferencesTool: AgentTool`, registered as `get_references`. Result shape unchanged from `project_map view=references`, including `duplicateLabels: string[]`.

**Renames inside this task:** `undefinedOnly` becomes `unresolvedOnly`, matching the `ReferenceUse.resolved` field it filters on.

**Note:** `tool-call-detail.tsx:295` has a dead `list_references` branch from an earlier rename. Rename its condition to `get_references`.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/get-references-tool.test.ts`:

```ts
import { expect } from 'chai'
import { getReferencesTool } from '../../../../frontend/js/features/ai-assist/agent/tools/get-references'
import { createFakeHandle } from './components/helpers/fake-handle'

describe('get_references', function () {
  it('names its filter after the field it filters', function () {
    const props = getReferencesTool.spec.parameters.properties as any
    expect(props).to.have.property('unresolvedOnly')
    expect(props).to.not.have.property('undefinedOnly')
  })

  it('documents a closed enum for kind', function () {
    const props = getReferencesTool.spec.parameters.properties as any
    expect(props.kind.enum).to.deep.equal([
      'labels',
      'refs',
      'citations',
      'all',
    ])
  })

  it('cannot change the project', function () {
    expect(getReferencesTool.mutates).to.equal(false)
  })

  it('reports whether each reference resolves', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\label{a}\n\\ref{a}\n\\ref{missing}\n' },
    })
    const result: any = await getReferencesTool.execute({}, handle)
    const missing = result.refs.find((r: any) => r.key === 'missing')
    expect(missing.resolved).to.equal(false)
  })

  it('returns only unresolved entries when asked', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\label{a}\n\\ref{a}\n\\ref{missing}\n' },
    })
    const result: any = await getReferencesTool.execute(
      { unresolvedOnly: true },
      handle
    )
    expect(result.refs.every((r: any) => !r.resolved)).to.equal(true)
  })

  it('surfaces duplicate labels', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': '\\label{dup}\nx\n\\label{dup}\n' },
    })
    const result: any = await getReferencesTool.execute({}, handle)
    expect(result.duplicateLabels).to.include('dup')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run the test command with `--grep "get_references"`.
Expected: failure resolving `tools/get-references`.

- [ ] **Step 3: Implement by extracting from `project-map.ts`**

Move the `view === 'references'` execute and render branches out of `project-map.ts` unchanged, renaming the `undefinedOnly` argument to `unresolvedOnly` at its two use sites inside the moved body. Spec:

```ts
  spec: {
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
      required: [],
    },
  },
  suspends: false,
  mutates: false,
```

- [ ] **Step 4: Point the renderer at the new name**

In `tool-call-detail.tsx:295`, change `if (call.name === 'list_references' && result) {` to `if (call.name === 'get_references' && result) {`.

- [ ] **Step 5: Register and run the tests**

Add `get_references: getReferencesTool` to `TOOLS`. Run the full test command.
Expected: the six new tests pass; failure count still 7.

---

### Task 6: `get_packages`

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/get-packages.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/get-packages-tool.test.ts`

**Interfaces:**
- Consumes: `AgentTool` with `mutates` (Task 1); `PackageUse` from `agent/context/project-index.ts`.
- Produces: `getPackagesTool: AgentTool`, registered as `get_packages`. Result shape unchanged from `project_map view=packages`: `{ documentClass: string | null; packages: Array<{ name: string; path: string; line: number }> }`.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/get-packages-tool.test.ts`:

```ts
import { expect } from 'chai'
import { getPackagesTool } from '../../../../frontend/js/features/ai-assist/agent/tools/get-packages'
import { createFakeHandle } from './components/helpers/fake-handle'

describe('get_packages', function () {
  it('takes no parameters at all', function () {
    expect(getPackagesTool.spec.parameters.properties).to.deep.equal({})
    expect(getPackagesTool.spec.parameters.required).to.deep.equal([])
  })

  it('cannot change the project', function () {
    expect(getPackagesTool.mutates).to.equal(false)
  })

  it('returns the documentclass and every package with where it is loaded', async function () {
    const { handle } = createFakeHandle({
      docs: {
        'main.tex': '\\documentclass{article}\n\\usepackage{graphicx}\n',
      },
    })
    const result: any = await getPackagesTool.execute({}, handle)
    expect(result.documentClass).to.equal('article')
    const graphicx = result.packages.find((p: any) => p.name === 'graphicx')
    expect(graphicx.path).to.equal('main.tex')
    expect(graphicx.line).to.equal(2)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run the test command with `--grep "get_packages"`.
Expected: failure resolving `tools/get-packages`.

- [ ] **Step 3: Implement by extracting from `project-map.ts`**

Move the `view === 'packages'` execute and render branches out unchanged. Spec:

```ts
  spec: {
    name: 'get_packages',
    description:
      'The documentclass and every \\usepackage in the project, with the file and line that loads it. Use this to check whether a command\'s package is available before assuming it is missing.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  suspends: false,
  mutates: false,
```

- [ ] **Step 4: Register and run the tests**

Add `get_packages: getPackagesTool` to `TOOLS`. Run the full test command.
Expected: the three new tests pass; failure count still 7.

---

### Task 7: Delete `project_map` and retire its tests

**Files:**
- Delete: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/project-map.ts`
- Delete: `modules/ai-assist/test/frontend/js/agent/project-map-tool.test.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-card.tsx:29,108,126`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-detail.tsx`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/starters/derive-starters.ts` (only if it references the tool by name)

**Interfaces:**
- Consumes: the four tools from Tasks 3–6.
- Produces: `TOOLS` no longer contains `project_map`.

**Before deleting `project-map-tool.test.ts`:** read it and confirm every behaviour it asserts is now covered by the four new test files. Anything not covered must be ported into the matching new file rather than lost. Note this check in your task report.

- [ ] **Step 1: Confirm coverage has moved**

Read `project-map-tool.test.ts`. For each `it(...)`, name the new test that now covers it. If any is uncovered, add it to the relevant new file and run that file before continuing.

- [ ] **Step 2: Remove the tool**

Delete `tools/project-map.ts` and its import and `TOOLS` entry in `registry.ts`. Delete `test/frontend/js/agent/project-map-tool.test.ts`.

- [ ] **Step 3: Remove its renderer branches**

In `tool-call-card.tsx`, delete the `case 'project_map':` arms at lines 29, 108 and 126. In `tool-call-detail.tsx`, delete any remaining `project_map` branch. Task 8 adds the fallback that catches stored calls still naming it.

- [ ] **Step 4: Run the tests**

Run the full test command.
Expected: failure count still 7. If a test fails naming `project_map`, it was asserting through the old tool and needs porting to whichever new tool now owns that behaviour.

- [ ] **Step 5: Verify no references remain**

Run: `grep -rn "project_map" modules/ai-assist/frontend modules/ai-assist/test`
Expected: no matches.

---

### Task 8: Legacy tool-call rendering

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-card.tsx:20-35`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-detail.tsx`
- Test: `modules/ai-assist/test/frontend/js/agent/components/legacy-tool-call.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. Behavioural guarantee: a stored call whose `name` is absent from the current registry renders its name and its args as formatted JSON, and throws nothing.

**Why:** conversations and fix runs persist `{ name, args, result }`. After Tasks 3–7, stored history contains `project_map`, `search_project` and `get_compile_log` calls that no branch handles.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/components/legacy-tool-call.test.tsx`:

```tsx
import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import { ToolCallCard } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-card'

const LEGACY = {
  id: 'c1',
  name: 'project_map',
  args: { view: 'outline' },
  result: { sections: [] },
}

describe('a stored call naming a tool that no longer exists', function () {
  it('renders without throwing', function () {
    expect(() => render(<ToolCallCard call={LEGACY as any} />)).to.not.throw()
  })

  it('shows the tool name it was recorded under', function () {
    render(<ToolCallCard call={LEGACY as any} />)
    expect(screen.getByText(/project_map/)).to.exist
  })

  it('shows the arguments as JSON when expanded', function () {
    const { container } = render(<ToolCallCard call={LEGACY as any} />)
    const summary = container.querySelector('.ai-assist-tool-call-summary')!
    ;(summary as HTMLElement).click()
    expect(container.textContent).to.contain('outline')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run the test command with `--grep "no longer exists"`.
Expected: the name is not rendered, because the `switch` has no arm and no default.

- [ ] **Step 3: Add the fallback to the summary line**

In `tool-call-card.tsx`, the `switch (name)` at line 20 maps tool names to titles. Add a `default` arm returning the raw name:

```ts
    default:
      // A call stored before a rename. Its name is the only honest thing we
      // can say about it, so say that rather than mislabelling it.
      return name
```

Do the same for the `switch (call.name)` at line 93 (the summary detail line), whose default should return `null` so no bespoke summary is invented.

- [ ] **Step 4: Add the fallback to the detail view**

`tool-call-detail.tsx` is a chain of `if (call.name === …)` guards that falls through to nothing. At the end of the chain, before the final return, add:

```tsx
  // Unrecognised tool: show the arguments verbatim rather than an empty panel.
  return (
    <pre className="ai-assist-tool-call-raw">
      {JSON.stringify(call.args, null, 2)}
    </pre>
  )
```

- [ ] **Step 5: Run the tests**

Run the full test command.
Expected: the three new tests pass; failure count still 7.

---

### Task 9: `search_text` and the `read_file` cleanup

**Files:**
- Rename: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/search-project.ts` → `search-text.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-card.tsx:27,98`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-detail.tsx:257`
- Test: `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts` (existing — update)

**Interfaces:**
- Consumes: `AgentTool` with `mutates` (Task 1).
- Produces: `searchTextTool: AgentTool` registered as `search_text`, param `glob` replacing `path`. `readFileTool` keeps `path`, `from`, `to` and loses `section`.

- [ ] **Step 1: Write the failing tests**

Append to `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts`:

```ts
describe('the read tools share one parameter vocabulary', function () {
  it('search_text takes a glob, not a path', function () {
    const props = searchTextTool.spec.parameters.properties as any
    expect(props).to.have.property('glob')
    expect(props).to.not.have.property('path')
  })

  it('read_file takes an exact path and line numbers only', function () {
    const props = readFileTool.spec.parameters.properties as any
    expect(Object.keys(props).sort()).to.deep.equal(['from', 'path', 'to'])
    expect(props).to.not.have.property('section')
  })

  it('search_text still narrows by pattern under the new name', async function () {
    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'needle', 'sections/a.tex': 'needle' },
    })
    const result: any = await searchTextTool.execute(
      { query: 'needle', glob: 'sections/*.tex' },
      handle
    )
    expect(result.matches.map((m: any) => m.path)).to.deep.equal([
      'sections/a.tex',
    ])
  })
})
```

Add the imports `searchTextTool` from `../../../../frontend/js/features/ai-assist/agent/tools/search-text` and `readFileTool` from `.../tools/read-file` at the top of the file if not already present.

- [ ] **Step 2: Run and confirm failure**

Run the test command with `--grep "one parameter vocabulary"`.
Expected: failure resolving `tools/search-text`.

- [ ] **Step 3: Rename the search tool**

Rename the file to `search-text.ts`. Rename the export `searchProjectTool` to `searchTextTool` and `spec.name` to `search_text`. Rename the `path` parameter to `glob` in the spec and at its use sites in `execute`. Replace the description with:

```ts
    description:
      'Find a string or regular expression across the project\'s text files, with surrounding context lines. Pass glob to search only matching files. Use this to locate something whose file you do not know.',
```

- [ ] **Step 4: Drop `read_file.section`**

In `read-file.ts`, delete the `section` property from the spec and the branch in `execute` that handles it. Update the description to:

```ts
    description:
      'Read one text file, or a line range of one, as numbered lines. Get the range from get_outline or search_text first rather than guessing it.',
```

- [ ] **Step 5: Update the registry and renderers**

In `registry.ts`, import `searchTextTool` and change the entry to `search_text: searchTextTool`. In `tool-call-card.tsx` change `case 'search_project':` to `case 'search_text':` at lines 27 and 98. In `tool-call-detail.tsx:257` change `if (call.name === 'search_project')` to `'search_text'`.

- [ ] **Step 6: Run the tests**

Run the full test command.
Expected: the three new tests pass; failure count still 7. Existing `read-tools.test.ts` cases asserting `section` must be deleted, not adapted — the capability is gone by design.

---

### Task 10: `get_compile_result`

**Files:**
- Rename: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/compile-log.ts` → `compile-result.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/registry.ts`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/fix-run.ts` (the `FIX_TOOLS` filter names `compile_project` and `create_file`)
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-card.tsx:23,106`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/agent/tool-call-detail.tsx:195`
- Test: `modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts` (existing — update)

**Interfaces:**
- Consumes: `AgentTool` with `mutates` (Task 1).
- Produces: `compileResultTool: AgentTool` registered as `get_compile_result`, param `limit` replacing `maxEntries`.

- [ ] **Step 1: Write the failing test**

Append to `modules/ai-assist/test/frontend/js/agent/compile-log-tool.test.ts`:

```ts
describe('get_compile_result', function () {
  it('caps results with limit, not maxEntries', function () {
    const props = compileResultTool.spec.parameters.properties as any
    expect(props).to.have.property('limit')
    expect(props).to.not.have.property('maxEntries')
  })

  it('documents a closed enum for severity', function () {
    const props = compileResultTool.spec.parameters.properties as any
    expect(props.severity.enum).to.deep.equal(['errors', 'warnings', 'all'])
  })

  it('cannot change the project', function () {
    expect(compileResultTool.mutates).to.equal(false)
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run the test command with `--grep "get_compile_result"`.
Expected: failure resolving `tools/compile-result`.

- [ ] **Step 3: Rename**

Rename the file to `compile-result.ts`, the export `compileLogTool` to `compileResultTool`, and `spec.name` to `get_compile_result`. Rename `maxEntries` to `limit` in the spec and at its use sites. Description:

```ts
    description:
      'The result of the last build: errors, warnings and raw log excerpts, without rebuilding. Pass severity to narrow and limit to cap the count.',
```

- [ ] **Step 4: Update every reference**

`registry.ts` (`get_compile_result: compileResultTool`), `tool-call-card.tsx` lines 23 and 106, `tool-call-detail.tsx:195`. Check `fix-run.ts`'s `FIX_TOOLS` filter still names only `compile_project` and `create_file` — with the split, a fix run should now receive `list_files`, `read_file`, `search_text`, `get_outline`, `get_references`, `get_packages`, `get_compile_result` and `edit_file`.

- [ ] **Step 5: Run the tests and verify the registry**

Run the full test command.
Expected: failure count still 7.

Then add to `modules/ai-assist/test/frontend/js/agent/mutation-gate.test.ts`:

```ts
  it('registers exactly the ten designed tools', function () {
    expect(Object.keys(TOOLS).sort()).to.deep.equal([
      'compile_project',
      'create_file',
      'edit_file',
      'get_compile_result',
      'get_outline',
      'get_packages',
      'get_references',
      'list_files',
      'read_file',
      'search_text',
    ])
  })
```

Run again. Expected: passes; failure count still 7.

---

### Task 11: Rewrite the system prompt's tool ladder

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/system-prompt.ts:50-80`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/fix-system-prompt.ts` (if it names tools)
- Test: `modules/ai-assist/test/frontend/js/agent/system-prompt.test.ts`

**Interfaces:**
- Consumes: the final tool names from Tasks 3–10.
- Produces: no new exports.

**Why last:** the prompt's `# Choosing a tool` section names `project_map` and its views throughout. Rewriting it before the tools exist would leave the prompt lying about the surface for several tasks.

- [ ] **Step 1: Write the failing test**

Create `modules/ai-assist/test/frontend/js/agent/system-prompt.test.ts`:

```ts
import { expect } from 'chai'
import { SYSTEM_PROMPT } from '../../../../frontend/js/features/ai-assist/agent/context/system-prompt'
import { TOOLS } from '../../../../frontend/js/features/ai-assist/agent/tools/registry'

describe('the system prompt describes the real tool surface', function () {
  it('names no tool that does not exist', function () {
    const named = SYSTEM_PROMPT.match(/`([a-z_]+)`/g) ?? []
    const toolish = named
      .map(m => m.replace(/`/g, ''))
      .filter(name => name.includes('_') && !name.startsWith('\\'))
    for (const name of toolish) {
      if (/^(get|list|read|search|compile|edit|create)_/.test(name)) {
        expect(TOOLS, `prompt names ${name}`).to.have.property(name)
      }
    }
  })

  it('no longer mentions the retired god-tool', function () {
    expect(SYSTEM_PROMPT).to.not.contain('project_map')
  })

  it('mentions every tool the model can call', function () {
    for (const name of Object.keys(TOOLS)) {
      expect(SYSTEM_PROMPT, `prompt omits ${name}`).to.contain(name)
    }
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run the test command with `--grep "describes the real tool surface"`.
Expected: fails on `project_map` still being present.

- [ ] **Step 3: Rewrite the ladder**

Replace the `# Choosing a tool` section's rungs with:

```
'# Choosing a tool',
'',
'Climb the ladder in order; each rung is cheaper than the one below it.',
'',
'1. Index queries — a few hundred tokens each, answered from a prebuilt',
'   index without touching a file. `get_outline` for the section tree and',
'   line ranges, `get_references` for labels, refs and citations with',
'   whether they resolve, `get_packages` for the documentclass and every',
'   \\usepackage, `list_files` for the file listing. Reach for these first',
'   on an unfamiliar project, and never read a file to answer a question',
'   about structure, references or packages.',
'2. `search_text` — scans the text files for a string or pattern. Use it',
'   when you know what you are looking for but not which file holds it.',
'3. `read_file` — the actual bytes of one file or line range. Get the range',
'   from `get_outline` or `search_text` first; do not guess it.',
'4. `get_compile_result` — what the last build reported, without rebuilding.',
'5. `compile_project` — a real build. Slow. Use it to verify your own edits,',
'   not to find out what already failed.',
'6. `edit_file` and `create_file` — the only tools that change anything. The',
'   user reviews every change as a diff and may reject it, so make the change',
'   you would defend, not the change you think will be accepted.',
```

- [ ] **Step 4: Run the tests**

Run the full test command.
Expected: the three new tests pass; failure count still 7.

- [ ] **Step 5: Full verification**

Run, in order:

```bash
# full suite
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit \
  --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js \
  --ignore '**/*.spec.{js,jsx,ts,tsx}' --ignore '**/helpers/**/*.{js,jsx,ts,tsx}' \
  --reporter dot modules/ai-assist/test/frontend

# types
../../node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep modules/ai-assist

# lint
../../node_modules/.bin/eslint modules/ai-assist/frontend modules/ai-assist/test
```

Expected: 7 failures (the known baseline), no new type errors beyond the six known lines, lint clean.

Then confirm the dev server picked it up:

```bash
docker logs --since 2m ai-assist-webpack-1 2>&1 | grep -iE "compiled|ERROR in" | tail -3
```

Expected: `compiled successfully`.

---

## Self-review notes

**Spec coverage.** Tool split → Tasks 3–7. Parameter vocabulary → Tasks 3, 5, 9, 10. Redundancy removal (`read_file.section`) → Task 9. Approval architecture → Tasks 1–2. Legacy rendering → Task 8. System prompt → Task 11. `FIX_TOOLS` subset → Task 10 Step 4. Every Part 1 requirement in the spec maps to a task.

**Not covered here, by design:** everything in the spec's Part 2 (starter recomputation, `fix_duplicate_labels`, `oneShot`, `<task reply>`, the envelope outline, the Advanced tools second entry). Those belong to the second plan.

**Type consistency.** `mutates` is the field name in Tasks 1, 2, 3, 4, 5, 6, 10. `readOnlyHandle` is the function name in Tasks 1 and 2. `searchTextTool`, `compileResultTool`, `getOutlineTool`, `getReferencesTool`, `getPackagesTool`, `listFilesTool` are used consistently between their defining task and the registry step that imports them.

**One risk flagged for the executor.** Tasks 3–6 say "move the body out of `project-map.ts` unchanged". That is deliberate — the extraction should be mechanical, and any behaviour change during the move will surface as a failure in `project-map-tool.test.ts`, which stays green until Task 7 deletes it. If a move requires changing logic, stop and report rather than improvising.
