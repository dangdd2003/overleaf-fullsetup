# AI Assist — Agent Modes (Manual / Accept edits / Plan) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement three AI agent permission modes (`manual`, `acceptEdits`, and `plan`) for Overleaf AI Assist main chat, providing server-side policy enforcement, a `present_plan` workflow with mode-switching approvals, mid-run mode switching, and a composer mode selector with `Shift+Tab` cycling.

**Architecture:** A pure server-side policy module (`AiAssistModePolicy.mjs`) categorizes every tool call as `allow`, `ask`, or `deny` and filters tool specs exposed to LLM APIs based on live mode. The agent run loop in `AiAssistRunManager.mjs` enforces this policy dynamically, adds dedicated approval flows for settings changes and plans, and enables mid-run mode transitions. The frontend adds mode selection in the composer, handles new approval card types, and persists the mode per conversation in chat history.

**Tech Stack:** Node.js (ESM), Express, Redis, React 18, TypeScript, Phosphor Icons, Mocha, Vitest.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-18-ai-assist-agent-modes-design.md`

## Global Constraints

- **Main Chat Scope Only:** Do not modify the error-panel one-click "Suggest fix" flow (`frontend/js/features/ai-assist/agent/fix-run.ts`, `components/suggest-fix-panel.tsx`, in-page `run-agent.ts`).
- **Server-Side Enforcement:** Never rely solely on system prompt instructions to restrict tools. The server harness must block denied tools and handle approvals.
- **Constant Base System Prompt:** `SYSTEM_PROMPT` in `AiAssistSystemPrompt.mjs` must remain an invariant constant for LLM prefix caching. Mode instructions must be appended via `systemPromptFor(mode)`.
- **No Autonomous Git Actions:** Do NOT run `git commit`, `git push`, `git checkout`, `git stash`, or create branches. Leave all modified and created files uncommitted in the working tree.
- **Test Environments:**
  - Backend unit tests run with:
    `cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run <test-file>`
  - Frontend unit tests run with:
    `cd overleaf/services/web && NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --require test/frontend/bootstrap.js <test-file>`
- **Preserve Existing Interfaces:** Backward compatibility for existing `awaitingApproval` events and legacy approval endpoints must be maintained.

---

### Task 1: Server Mode Policy Module (`AiAssistModePolicy.mjs`)

**Files:**
- Create: `overleaf/services/web/modules/ai-assist/app/src/AiAssistModePolicy.mjs`
- Test: `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistModePolicy.test.mjs`

**Interfaces:**
- Consumes: Tool names from existing ai-assist tools
- Produces:
  ```js
  export const MODES = ['manual', 'acceptEdits', 'plan']
  export const DEFAULT_MODE = 'manual'
  export function normalizeMode(value: unknown): 'manual' | 'acceptEdits' | 'plan'
  export const SETTINGS_TOOLS: Set<string>
  export const PLAN_TOOL: 'present_plan'
  export const FILE_EDIT_TOOLS: Set<string>
  export const READ_ONLY_TOOLS: Set<string>
  export const PRESENT_PLAN_SPEC: object
  export function decide(mode: string, toolName: string): 'allow' | 'ask' | 'deny'
  export function toolSpecsFor(mode: string, allSpecs: Array<{ name: string }>): Array<object>
  ```

- [ ] **Step 1: Write the failing unit test for mode policy**

Create `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistModePolicy.test.mjs`:
```js
import { expect } from 'chai'
import {
  MODES,
  DEFAULT_MODE,
  normalizeMode,
  decide,
  toolSpecsFor,
  PRESENT_PLAN_SPEC,
  FILE_EDIT_TOOLS,
  READ_ONLY_TOOLS,
  SETTINGS_TOOLS,
  PLAN_TOOL,
} from '../../../../modules/ai-assist/app/src/AiAssistModePolicy.mjs'

describe('AiAssistModePolicy', () => {
  describe('normalizeMode', () => {
    it('returns valid modes unchanged', () => {
      expect(normalizeMode('manual')).to.equal('manual')
      expect(normalizeMode('acceptEdits')).to.equal('acceptEdits')
      expect(normalizeMode('plan')).to.equal('plan')
    })

    it('defaults invalid or missing values to manual', () => {
      expect(normalizeMode(undefined)).to.equal(DEFAULT_MODE)
      expect(normalizeMode(null)).to.equal(DEFAULT_MODE)
      expect(normalizeMode('')).to.equal(DEFAULT_MODE)
      expect(normalizeMode('unknown')).to.equal(DEFAULT_MODE)
    })
  })

  describe('decide', () => {
    it('handles manual mode', () => {
      expect(decide('manual', 'read_file')).to.equal('allow')
      expect(decide('manual', 'compile_project')).to.equal('allow')
      expect(decide('manual', 'edit_file')).to.equal('ask')
      expect(decide('manual', 'create_file')).to.equal('ask')
      expect(decide('manual', 'configure_appearance_settings')).to.equal('ask')
      expect(decide('manual', 'present_plan')).to.equal('deny')
    })

    it('handles acceptEdits mode', () => {
      expect(decide('acceptEdits', 'read_file')).to.equal('allow')
      expect(decide('acceptEdits', 'compile_project')).to.equal('allow')
      expect(decide('acceptEdits', 'edit_file')).to.equal('allow')
      expect(decide('acceptEdits', 'create_file')).to.equal('allow')
      expect(decide('acceptEdits', 'configure_editor_settings')).to.equal('ask')
      expect(decide('acceptEdits', 'present_plan')).to.equal('deny')
    })

    it('handles plan mode', () => {
      expect(decide('plan', 'read_file')).to.equal('allow')
      expect(decide('plan', 'search_text')).to.equal('allow')
      expect(decide('plan', 'compile_project')).to.equal('allow')
      expect(decide('plan', 'get_compile_result')).to.equal('allow')
      expect(decide('plan', 'edit_file')).to.equal('deny')
      expect(decide('plan', 'create_file')).to.equal('deny')
      expect(decide('plan', 'configure_compiler_settings')).to.equal('deny')
      expect(decide('plan', 'present_plan')).to.equal('ask')
      expect(decide('plan', 'unknown_tool')).to.equal('deny')
    })
  })

  describe('toolSpecsFor', () => {
    const sampleSpecs = [
      { name: 'read_file' },
      { name: 'edit_file' },
      { name: 'create_file' },
      { name: 'configure_editor_settings' },
      { name: 'compile_project' },
    ]

    it('returns all specs and excludes present_plan for manual mode', () => {
      const specs = toolSpecsFor('manual', sampleSpecs)
      const names = specs.map(s => s.name)
      expect(names).to.include.members(['read_file', 'edit_file', 'create_file', 'configure_editor_settings', 'compile_project'])
      expect(names).to.not.include('present_plan')
    })

    it('returns all specs and excludes present_plan for acceptEdits mode', () => {
      const specs = toolSpecsFor('acceptEdits', sampleSpecs)
      const names = specs.map(s => s.name)
      expect(names).to.include.members(['read_file', 'edit_file', 'create_file', 'configure_editor_settings', 'compile_project'])
      expect(names).to.not.include('present_plan')
    })

    it('excludes edit and settings tools and includes present_plan for plan mode', () => {
      const specs = toolSpecsFor('plan', sampleSpecs)
      const names = specs.map(s => s.name)
      expect(names).to.include.members(['read_file', 'compile_project', 'present_plan'])
      expect(names).to.not.include('edit_file')
      expect(names).to.not.include('create_file')
      expect(names).to.not.include('configure_editor_settings')
      expect(specs.find(s => s.name === 'present_plan')).to.deep.equal(PRESENT_PLAN_SPEC)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistModePolicy.test.mjs
```
Expected: FAIL with "Cannot find module ... AiAssistModePolicy.mjs"

- [ ] **Step 3: Implement minimal code for AiAssistModePolicy.mjs**

Create `overleaf/services/web/modules/ai-assist/app/src/AiAssistModePolicy.mjs`:
```js
export const MODES = ['manual', 'acceptEdits', 'plan']
export const DEFAULT_MODE = 'manual'

export function normalizeMode(value) {
  return typeof value === 'string' && MODES.includes(value) ? value : DEFAULT_MODE
}

export const FILE_EDIT_TOOLS = new Set(['edit_file', 'create_file'])

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

export const SETTINGS_TOOLS = new Set([
  'configure_appearance_settings',
  'configure_compiler_settings',
  'configure_editor_settings',
])

export const PLAN_TOOL = 'present_plan'

export const PRESENT_PLAN_SPEC = {
  name: 'present_plan',
  description:
    'Present your finished plan to the user for approval. Call this once research is complete and you know exactly what to change. The user will approve (you then switch to an editing mode and carry the plan out) or ask you to keep planning with feedback.',
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The plan in Markdown: what will change, in which files, in what order.',
      },
    },
    required: ['plan'],
  },
}

export function decide(mode, toolName) {
  const normMode = normalizeMode(mode)

  if (toolName === PLAN_TOOL) {
    return normMode === 'plan' ? 'ask' : 'deny'
  }

  if (READ_ONLY_TOOLS.has(toolName) || toolName === 'compile_project') {
    return 'allow'
  }

  if (FILE_EDIT_TOOLS.has(toolName)) {
    if (normMode === 'plan') return 'deny'
    if (normMode === 'acceptEdits') return 'allow'
    return 'ask' // manual
  }

  if (SETTINGS_TOOLS.has(toolName)) {
    if (normMode === 'plan') return 'deny'
    return 'ask' // manual & acceptEdits
  }

  // Unknown tools: in plan mode deny; in other modes allow so standard unknown-tool handling triggers
  return normMode === 'plan' ? 'deny' : 'allow'
}

export function toolSpecsFor(mode, allSpecs = []) {
  const normMode = normalizeMode(mode)
  const filtered = allSpecs.filter(spec => decide(normMode, spec.name) !== 'deny')

  if (normMode === 'plan') {
    if (!filtered.some(spec => spec.name === PLAN_TOOL)) {
      return [...filtered, PRESENT_PLAN_SPEC]
    }
  }

  return filtered
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistModePolicy.test.mjs
```
Expected: PASS with all tests passing.

---

### Task 2: Mode-Aware System Prompt (`AiAssistSystemPrompt.mjs`)

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistSystemPrompt.mjs`
- Test: `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistSystemPrompt.test.mjs`

**Interfaces:**
- Consumes: `normalizeMode` from `AiAssistModePolicy.mjs`
- Produces:
  ```js
  export const SYSTEM_PROMPT: string[]
  export const MODE_PROMPTS: Record<'manual' | 'acceptEdits' | 'plan', string>
  export function systemPromptFor(mode: string): string
  ```

- [ ] **Step 1: Write the failing unit test for systemPromptFor**

Create `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistSystemPrompt.test.mjs`:
```js
import { expect } from 'chai'
import {
  SYSTEM_PROMPT,
  MODE_PROMPTS,
  systemPromptFor,
} from '../../../../modules/ai-assist/app/src/AiAssistSystemPrompt.mjs'

describe('AiAssistSystemPrompt', () => {
  it('preserves SYSTEM_PROMPT as an array of strings', () => {
    expect(SYSTEM_PROMPT).to.be.an('array')
    expect(SYSTEM_PROMPT.length).to.be.greaterThan(10)
  })

  it('provides distinct, non-empty MODE_PROMPTS for each mode', () => {
    expect(MODE_PROMPTS.manual).to.be.a('string').and.not.be.empty
    expect(MODE_PROMPTS.acceptEdits).to.be.a('string').and.not.be.empty
    expect(MODE_PROMPTS.plan).to.be.a('string').and.not.be.empty
    expect(MODE_PROMPTS.manual).to.not.equal(MODE_PROMPTS.plan)
  })

  it('systemPromptFor appends the respective mode prompt', () => {
    const baseJoined = SYSTEM_PROMPT.join('\n')

    const manualPrompt = systemPromptFor('manual')
    expect(manualPrompt).to.equal(`${baseJoined}\n\n${MODE_PROMPTS.manual}`)

    const acceptPrompt = systemPromptFor('acceptEdits')
    expect(acceptPrompt).to.equal(`${baseJoined}\n\n${MODE_PROMPTS.acceptEdits}`)

    const planPrompt = systemPromptFor('plan')
    expect(planPrompt).to.equal(`${baseJoined}\n\n${MODE_PROMPTS.plan}`)
    expect(planPrompt).to.include('present_plan')

    // Defaults to manual on unknown
    expect(systemPromptFor('invalid')).to.equal(manualPrompt)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistSystemPrompt.test.mjs
```
Expected: FAIL with "systemPromptFor is not a function"

- [ ] **Step 3: Implement mode prompts in AiAssistSystemPrompt.mjs**

Update `overleaf/services/web/modules/ai-assist/app/src/AiAssistSystemPrompt.mjs` to add `MODE_PROMPTS` and `systemPromptFor`:
```js
import { normalizeMode } from './AiAssistModePolicy.mjs'

export const SYSTEM_PROMPT = [
  'You are an AI assistant embedded in the Overleaf LaTeX editor. You are',
  // ... existing lines preserved exactly as they are ...
]

export const MODE_PROMPTS = {
  manual: [
    '# Mode: Manual',
    '',
    'You are in Manual mode. File edits, file creations, and project/editor settings changes require user approval before they are applied. Propose changes by calling the appropriate tool (such as edit_file or configure_editor_settings); the user will be prompted to review and approve or decline. If the user declines, acknowledge their decision, address their feedback, and do not repeat the change.',
  ].join('\n'),

  acceptEdits: [
    '# Mode: Accept edits',
    '',
    'You are in Accept edits mode. File edits and creations apply immediately without waiting for approval. However, appearance and editor settings changes still require user confirmation. Carry out requested file changes directly and verify them with compilation when appropriate.',
  ].join('\n'),

  plan: [
    '# Mode: Plan',
    '',
    'You are in Plan mode. You cannot edit files or change settings in this mode. Read, search, inspect project structure, and compile to diagnose and explore. Once your research is complete and you know exactly what to change, call the `present_plan` tool with a concrete, Markdown-formatted plan detailing what will change, in which files, and in what sequence. The user will review your plan and choose whether to approve it (switching you to an editing mode to carry it out) or ask you to keep planning with feedback.',
    'If the user only asked a conceptual or explanatory question, answer it directly without calling present_plan.',
  ].join('\n'),
}

export function systemPromptFor(mode) {
  const normMode = normalizeMode(mode)
  return `${SYSTEM_PROMPT.join('\n')}\n\n${MODE_PROMPTS[normMode]}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistSystemPrompt.test.mjs
```
Expected: PASS

---

### Task 3: Run Store and Persistence for Mode (`AiAssistRunStore.mjs`)

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunStore.mjs:42-70`
- Test: `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs`

**Interfaces:**
- Consumes: `normalizeMode` from `AiAssistModePolicy.mjs`
- Produces:
  ```js
  store.createRun({ runId, projectId, userId, metadata, mode })
  store.getRun(runId): Promise<{ ...run, mode: 'manual' | 'acceptEdits' | 'plan' }>
  store.setMode(runId, mode): Promise<void>
  ```

- [ ] **Step 1: Write the failing unit test for RunStore mode support**

Create `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs`:
```js
import { expect } from 'chai'
import { AiAssistRunStore } from '../../../../modules/ai-assist/app/src/AiAssistRunStore.mjs'

describe('AiAssistRunStore mode support', () => {
  let mockRedis
  let store

  beforeEach(() => {
    const data = new Map()
    mockRedis = {
      hset: async (key, fieldOrObj, val) => {
        let entry = data.get(key) || {}
        if (typeof fieldOrObj === 'object') {
          entry = { ...entry, ...fieldOrObj }
        } else {
          entry[fieldOrObj] = val
        }
        data.set(key, entry)
      },
      hgetall: async key => data.get(key) || {},
      sadd: async () => {},
      srem: async () => {},
      expire: async () => {},
    }
    store = new AiAssistRunStore(mockRedis)
  })

  it('stores and retrieves mode on createRun', async () => {
    await store.createRun({
      runId: 'run_123',
      projectId: 'proj_1',
      userId: 'user_1',
      mode: 'plan',
    })

    const run = await store.getRun('run_123')
    expect(run).to.not.be.null
    expect(run.mode).to.equal('plan')
  })

  it('defaults mode to manual when omitted on createRun', async () => {
    await store.createRun({
      runId: 'run_def',
      projectId: 'proj_1',
      userId: 'user_1',
    })

    const run = await store.getRun('run_def')
    expect(run.mode).to.equal('manual')
  })

  it('updates mode via setMode', async () => {
    await store.createRun({
      runId: 'run_456',
      projectId: 'proj_1',
      userId: 'user_1',
      mode: 'manual',
    })

    await store.setMode('run_456', 'acceptEdits')
    const run = await store.getRun('run_456')
    expect(run.mode).to.equal('acceptEdits')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs
```
Expected: FAIL with "store.setMode is not a function"

- [ ] **Step 3: Implement mode support in AiAssistRunStore.mjs**

In `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunStore.mjs`:
Import `normalizeMode`:
```js
import { normalizeMode } from './AiAssistModePolicy.mjs'
```

In `createRun`:
```js
  async createRun({ runId, projectId, userId, metadata = {}, mode = 'manual' }) {
    const rclient = this.getClient()
    if (!rclient) return
    const key = this._key(runId)
    const now = Date.now()
    await rclient.hset(key, {
      runId,
      projectId,
      userId,
      mode: normalizeMode(mode),
      status: 'running',
      heartbeat: String(now),
      createdAt: String(now),
      watchers: '0',
      zeroSince: '',
      metadata: JSON.stringify(metadata),
    })
    await rclient.sadd(ACTIVE_RUNS_KEY, runId)
    await rclient.expire(ACTIVE_RUNS_KEY, RUN_TTL_SECONDS)
    await rclient.expire(key, RUN_TTL_SECONDS)
    await rclient.expire(this._eventsKey(runId), RUN_TTL_SECONDS)
  }
```

In `getRun`:
```js
  async getRun(runId) {
    const rclient = this.getClient()
    if (!rclient) return null
    const data = await rclient.hgetall(this._key(runId))
    if (!data || Object.keys(data).length === 0) return null
    return {
      ...data,
      mode: normalizeMode(data.mode),
      heartbeat: Number(data.heartbeat || 0),
      createdAt: Number(data.createdAt || 0),
      metadata: data.metadata ? JSON.parse(data.metadata) : {},
    }
  }
```

Add `setMode`:
```js
  async setMode(runId, mode) {
    const rclient = this.getClient()
    if (!rclient) return
    await rclient.hset(this._key(runId), {
      mode: normalizeMode(mode),
      heartbeat: String(Date.now()),
    })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunStore.test.mjs
```
Expected: PASS

---

### Task 4: Run Manager Mode Enforcement & Approvals (`AiAssistRunManager.mjs`)

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunManager.mjs`
- Test: `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`

**Interfaces:**
- Consumes:
  - `AiAssistModePolicy.mjs` (`decide`, `toolSpecsFor`, `normalizeMode`, `SETTINGS_TOOLS`, `PLAN_TOOL`, `FILE_EDIT_TOOLS`, `READ_ONLY_TOOLS`)
  - `systemPromptFor` from `AiAssistSystemPrompt.mjs`
- Produces:
  - `startRun({ runId, projectId, userId, transcript, providerSettings, mode })`
  - `setMode(runId, mode)`
  - `onCommand({ runId, action, mode, ... })`

- [ ] **Step 1: Write unit tests for RunManager mode scenarios**

Add tests to `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs`:
```js
  it('enforces acceptEdits mode: auto-applies file edits without emitting awaitingApproval', async () => {
    let approvalEmitted = false
    let toolExecuted = false
    const fakeTools = {
      getToolSpecs: () => [{ name: 'edit_file' }],
      checkEdit: async () => ({ status: 'ok', path: 'main.tex', oldText: 'a', newText: 'b' }),
      execute: async (name, args) => {
        if (name === 'edit_file') toolExecuted = true
        return { status: 'applied' }
      },
    }
    const fakeStore = createMockStore()
    const originalAppend = fakeStore.appendEvent
    fakeStore.appendEvent = async (runId, event) => {
      if (event.type === 'awaitingApproval') approvalEmitted = true
      return originalAppend(runId, event)
    }

    const fakeClient = {
      streamChat: async function* () {
        yield { type: 'tool_call', id: 'call_1', name: 'edit_file', args: { path: 'main.tex', oldText: 'a', newText: 'b' } }
      },
    }

    const manager = new AiAssistRunManager({
      store: fakeStore,
      tools: fakeTools,
      clientFactory: () => fakeClient,
    })

    await manager.startRun({
      runId: 'test_accept_edits',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', text: 'fix typo' }],
      providerSettings: { type: 'anthropic' },
      mode: 'acceptEdits',
    })

    expect(toolExecuted).to.be.true
    expect(approvalEmitted).to.be.false
  })

  it('enforces plan mode: denies edit_file call, excludes edit tools from specs, includes present_plan', async () => {
    let capturedTools = null
    let toolExecuted = false
    const fakeTools = {
      getToolSpecs: () => [{ name: 'read_file' }, { name: 'edit_file' }],
      execute: async () => { toolExecuted = true },
    }
    const fakeStore = createMockStore()
    const capturedEvents = []
    fakeStore.appendEvent = async (runId, event) => {
      capturedEvents.push(event)
    }

    let turn = 0
    const fakeClient = {
      streamChat: async function* (options) {
        capturedTools = options.tools
        turn++
        if (turn === 1) {
          yield { type: 'tool_call', id: 'call_edit', name: 'edit_file', args: { path: 'main.tex', newText: 'foo' } }
        } else {
          yield { type: 'text', text: 'I understand.' }
        }
      },
    }

    const manager = new AiAssistRunManager({
      store: fakeStore,
      tools: fakeTools,
      clientFactory: () => fakeClient,
    })

    await manager.startRun({
      runId: 'test_plan_mode',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', text: 'plan work' }],
      providerSettings: { type: 'anthropic' },
      mode: 'plan',
    })

    expect(toolExecuted).to.be.false
    const names = capturedTools.map(t => t.name)
    expect(names).to.include('read_file')
    expect(names).to.include('present_plan')
    expect(names).to.not.include('edit_file')

    const finishedCall = capturedEvents.find(e => e.type === 'toolCallFinished' && e.id === 'call_edit')
    expect(finishedCall).to.exist
    expect(finishedCall.result.status).to.equal('denied')
  })

  it('handles present_plan approval: switches mode and emits modeChanged', async () => {
    const fakeTools = {
      getToolSpecs: () => [{ name: 'read_file' }, { name: 'edit_file' }],
      execute: async () => ({ status: 'applied' }),
    }
    const fakeStore = createMockStore()
    const capturedEvents = []
    fakeStore.appendEvent = async (runId, event) => {
      capturedEvents.push(event)
    }

    let turn = 0
    const fakeClient = {
      streamChat: async function* () {
        turn++
        if (turn === 1) {
          yield { type: 'tool_call', id: 'call_plan', name: 'present_plan', args: { plan: 'Step 1: edit main.tex' } }
        } else {
          yield { type: 'text', text: 'Executing plan.' }
        }
      },
    }

    const manager = new AiAssistRunManager({
      store: fakeStore,
      tools: fakeTools,
      clientFactory: () => fakeClient,
    })

    const runPromise = manager.startRun({
      runId: 'test_present_plan',
      projectId: 'p1',
      userId: 'u1',
      transcript: [{ role: 'user', text: 'make a plan' }],
      providerSettings: { type: 'anthropic' },
      mode: 'plan',
    })

    // Wait for awaitingApproval event
    await new Promise(resolve => setTimeout(resolve, 50))
    await manager.approveEdit('test_present_plan', { accepted: true, nextMode: 'acceptEdits' })
    await runPromise

    const modeChangedEvent = capturedEvents.find(e => e.type === 'modeChanged')
    expect(modeChangedEvent).to.exist
    expect(modeChangedEvent.mode).to.equal('acceptEdits')
    expect(modeChangedEvent.source).to.equal('planApproval')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs
```
Expected: FAIL on the newly added tests.

- [ ] **Step 3: Implement RunManager mode handling and approvals**

In `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunManager.mjs`:
1. Import policy and prompt helpers:
```js
import {
  decide,
  toolSpecsFor,
  normalizeMode,
  FILE_EDIT_TOOLS,
  READ_ONLY_TOOLS,
  SETTINGS_TOOLS,
  PLAN_TOOL,
} from './AiAssistModePolicy.mjs'
import { systemPromptFor } from './AiAssistSystemPrompt.mjs'
```
Re-export `FILE_EDIT_TOOLS` and `READ_ONLY_TOOLS` for backward compatibility.

2. In `startRun({ runId, projectId, userId, transcript, providerSettings, mode = 'manual' })`:
Normalize mode:
```js
const initialMode = normalizeMode(mode)
this.activeRuns.set(runId, {
  controller,
  projectId,
  userId,
  mode: initialMode,
  approvalResolver: approvalPromiseResolvers,
  compileResolvers,
})

await this.store.createRun({ runId, projectId, userId, mode: initialMode })
```

3. In the run turn loop:
```js
while (true) {
  if (controller.signal.aborted || shouldStop) break

  const currentMode = this.activeRuns.get(runId)?.mode || 'manual'
  const currentSystemPrompt = systemPromptFor(currentMode)

  const allToolSpecs = this.tools?.getToolSpecs ? this.tools.getToolSpecs() : []
  const modeToolSpecs = toolSpecsFor(currentMode, allToolSpecs)
  const toolsToUse = userDeclinedEdit
    ? modeToolSpecs.filter(spec => !FILE_EDIT_TOOLS.has(spec.name))
    : modeToolSpecs

  const budgeted = applyContextBudget({
    system: currentSystemPrompt,
    messages,
    limits: resolvedLimits,
    tools: toolsToUse,
  })
  // ...
  for await (const chunk of client.streamChat({
    system: currentSystemPrompt,
    messages,
    tools: toolsToUse,
    // ...
```

4. Helper for awaiting approval:
```js
const awaitUserApproval = async (approvalData) => {
  await this.store.setPendingApproval(runId, approvalData)
  await emitEvent({
    type: 'awaitingApproval',
    ...approvalData,
  })

  let timer = null
  let onAbort = null
  let settled = false

  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (onAbort) {
      controller.signal.removeEventListener('abort', onAbort)
      onAbort = null
    }
    approvalPromiseResolvers.resolve = null
  }

  await this.store.touchHeartbeat?.(runId, 0)
  const decision = await new Promise(resolve => {
    const settle = value => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    approvalPromiseResolvers.resolve = settle
    timer = setTimeout(
      () => settle({ accepted: false, note: 'Approval timed out' }),
      this.approvalTimeoutMs
    )
    timer.unref?.()
    onAbort = () => settle({ accepted: false, note: 'Run stopped' })
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener('abort', onAbort)
  })
  await this.store.touchHeartbeat?.(runId, 0)
  return decision
}
```

5. In the call execution loop, evaluate `const liveMode = this.activeRuns.get(runId)?.mode || 'manual'`:
```js
const verdict = decide(liveMode, call.name)

if (verdict === 'deny') {
  result = {
    status: 'denied',
    error: `This tool is not available in ${liveMode} mode.${liveMode === 'plan' ? ' Use read-only tools and call present_plan.' : ''}`,
  }
  isError = true
} else if (call.name === 'edit_file' || call.name === 'create_file') {
  if (userDeclinedEdit) {
    result = {
      status: 'rejected',
      error: 'The user has already declined previous edits in this turn. Further file modifications are blocked. Acknowledge to the user and explain alternatives or ask how to proceed.',
    }
    shouldStop = true
  } else if (editPlan && editPlan.status !== 'ok') {
    result = editPlan
  } else {
    const isCreate = call.name === 'create_file'
    const resolvedOldText = editPlan?.oldText !== undefined ? editPlan.oldText : (isCreate ? '' : (call.args.oldText || ''))
    const resolvedNewText = editPlan?.newText !== undefined ? editPlan.newText : (isCreate ? (call.args.content || '') : (call.args.newText || ''))
    const action = isCreate
      ? 'create'
      : (!resolvedOldText ? 'append' : (!resolvedNewText ? 'delete' : 'edit'))
    const approvalEdit = {
      ...call.args,
      path: editPlan?.path || call.args.path,
      oldText: resolvedOldText,
      newText: resolvedNewText,
      startLine: editPlan?.startLine,
      action,
      toolName: call.name,
    }

    const execArgs = {
      ...call.args,
      path: editPlan?.path || call.args.path,
      ...(editPlan?.oldText !== undefined ? { oldText: editPlan.oldText } : {}),
      ...(editPlan?.newText !== undefined ? { newText: editPlan.newText } : {}),
    }

    if (verdict === 'allow') {
      // acceptEdits mode: auto-apply directly
      try {
        result = await this.tools.execute(call.name, execArgs, { projectId, userId })
      } catch (err) {
        result = { error: err.message || 'Tool execution failed' }
        isError = true
      }
    } else {
      // manual mode: ask for approval
      const decision = await awaitUserApproval({
        id: call.id,
        kind: 'edit',
        edit: approvalEdit,
      })

      if (!decision?.accepted) {
        userDeclinedEdit = true
        const userNote = decision?.note ? ` with note: "${decision.note}"` : ''
        result = {
          status: 'rejected',
          message: `The user declined this change${userNote}. Do not attempt any further file modifications or repeat this edit in this turn. Acknowledge to the user that the edit was rejected, address their feedback, and explain alternatives or ask how they would like to proceed.`,
          note: decision?.note,
        }
      } else {
        try {
          result = await this.tools.execute(call.name, execArgs, { projectId, userId })
        } catch (err) {
          result = { error: err.message || 'Tool execution failed' }
          isError = true
        }
      }
    }
  }
} else if (SETTINGS_TOOLS.has(call.name) && verdict === 'ask') {
  const decision = await awaitUserApproval({
    id: call.id,
    kind: 'settings',
    settings: { toolName: call.name, args: call.args },
  })

  if (!decision?.accepted) {
    const userNote = decision?.note ? ` with note: "${decision.note}"` : ''
    result = {
      status: 'rejected',
      message: `The user declined this settings change${userNote}. Do not retry it in this turn.`,
      note: decision?.note,
    }
  } else {
    try {
      result = await this.tools.execute(call.name, call.args, toolContext(call))
    } catch (err) {
      result = { error: err.message || 'Tool execution failed' }
      isError = true
    }
  }
} else if (call.name === PLAN_TOOL && verdict === 'ask') {
  const planText = typeof call.args?.plan === 'string' ? call.args.plan : ''
  const decision = await awaitUserApproval({
    id: call.id,
    kind: 'plan',
    plan: planText,
  })

  if (decision?.accepted) {
    const nextMode = normalizeMode(decision.nextMode || 'manual')
    const active = this.activeRuns.get(runId)
    if (active) active.mode = nextMode
    await this.store.setMode(runId, nextMode)
    await emitEvent({ type: 'modeChanged', mode: nextMode, source: 'planApproval' })
    result = {
      status: 'approved',
      mode: nextMode,
      message: `The user approved the plan. You are now in ${nextMode === 'acceptEdits' ? 'Accept edits' : 'Manual'} mode: carry out the plan now.`,
    }
  } else {
    const userNote = decision?.note ? ` with note: "${decision.note}"` : ''
    result = {
      status: 'keepPlanning',
      note: decision?.note,
      message: `The user wants you to keep planning${userNote}. Revise the plan using their feedback and call present_plan again.`,
    }
  }
} else if (prefetched.has(call)) {
  const done = prefetched.get(call)
  result = done.result
  isError = done.isError
} else {
  try {
    result = await this.tools.execute(call.name, call.args, toolContext(call))
  } catch (err) {
    result = { error: err.message || 'Tool execution failed' }
    isError = true
  }
}
```

6. Don't count `denied` calls towards failure counts:
```js
const isFailed =
  (isError && result?.status !== 'denied') ||
  result?.error ||
  result?.status === 'noMatch' ||
  result?.status === 'ambiguous' ||
  result?.status === 'none'
```

7. Implement `setMode` and control channel command:
```js
  async setMode(runId, mode) {
    const normalized = normalizeMode(mode)
    const active = this.activeRuns.get(runId)
    if (active) {
      active.mode = normalized
      await this.store.setMode(runId, normalized)
      await this.store.appendEvent(runId, { type: 'modeChanged', mode: normalized, source: 'user' })
      return
    }
    if (this.control) {
      await this.control.publish(runId, { action: 'setMode', mode: normalized }).catch(() => {})
    } else {
      await this.store.setMode(runId, normalized)
    }
  }
```
In `onCommand`:
```js
    if (action === 'setMode') {
      const active = this.activeRuns.get(runId)
      if (active) {
        active.mode = mode
        void this.store.setMode(runId, mode).catch(() => {})
        void this.store.appendEvent(runId, { type: 'modeChanged', mode, source: 'user' }).catch(() => {})
      }
      return
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunManager.test.mjs
```
Expected: PASS with all 36+ tests passing.

---

### Task 5: HTTP Endpoints & Chat History Mode (`AiAssistRunController.mjs`, `AiAssistRunRouter.mjs`, `AiAssistChatHistoryStore.mjs`)

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunController.mjs`
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunRouter.mjs`
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistChatHistoryStore.mjs`
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistChatHistoryController.mjs`
- Test: `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistModeEndpoints.test.mjs`

**Interfaces:**
- Consumes: `MODES`, `normalizeMode` from `AiAssistModePolicy.mjs`
- Produces:
  - `POST /ai-assist/projects/:Project_id/runs/:runId/mode`
  - `saveChat(projectId, userId, chatId, transcript, mode)` returns chat with `mode`
  - `PUT /ai-assist/projects/:Project_id/chats/:chatId` accepts `req.body.mode`

- [ ] **Step 1: Write unit tests for HTTP routes and Chat History store mode**

Create `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistModeEndpoints.test.mjs`:
```js
import { expect } from 'chai'
import AiAssistChatHistoryStore from '../../../../modules/ai-assist/app/src/AiAssistChatHistoryStore.mjs'

describe('AiAssistChatHistoryStore mode', () => {
  const projectId = '0123456789abcdef01234567'
  const userId = 'abcdef0123456789abcdef01'
  const chatId = 'test-chat-mode'

  afterEach(async () => {
    await AiAssistChatHistoryStore.deleteChat(projectId, userId, chatId).catch(() => {})
  })

  it('saves and retrieves chat with mode', async () => {
    const transcript = [{ role: 'user', text: 'Hello' }]
    await AiAssistChatHistoryStore.saveChat(projectId, userId, chatId, transcript, 'plan')

    const chat = await AiAssistChatHistoryStore.getChat(projectId, userId, chatId)
    expect(chat).to.not.be.null
    expect(chat.mode).to.equal('plan')
    expect(chat.title).to.equal('Hello')
  })

  it('defaults mode to manual when omitted in saveChat', async () => {
    const transcript = [{ role: 'user', text: 'Default test' }]
    await AiAssistChatHistoryStore.saveChat(projectId, userId, chatId, transcript)

    const chat = await AiAssistChatHistoryStore.getChat(projectId, userId, chatId)
    expect(chat.mode).to.equal('manual')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistModeEndpoints.test.mjs
```
Expected: FAIL with `expect(chat.mode).to.equal('plan')` (since mode is not yet saved).

- [ ] **Step 3: Implement controller, router, and chat history changes**

In `overleaf/services/web/modules/ai-assist/app/src/AiAssistChatHistoryStore.mjs`:
Update `saveChat`:
```js
import { normalizeMode } from './AiAssistModePolicy.mjs'
// ...
async function saveChat(projectId, userId, chatId, transcript, mode = 'manual') {
  const file = fileFor(projectId, userId, chatId)
  const existing = await readChat(file).catch(() => null)
  const now = Date.now()
  const chat = {
    id: chatId,
    projectId: String(projectId),
    userId: String(userId),
    title: titleFor(transcript),
    mode: normalizeMode(mode || existing?.mode),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    transcript,
  }
  await fs.mkdir(Path.dirname(file), { recursive: true })
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(chat))
  await fs.rename(tmp, file)
  const { transcript: _omit, ...summary } = chat
  return { ...summary, messageCount: transcript.length }
}
```

In `overleaf/services/web/modules/ai-assist/app/src/AiAssistChatHistoryController.mjs`:
In `save = async (req, res) =>`:
```js
  save = async (req, res) => {
    const ids = this.#ids(req, res)
    if (!ids) return
    const transcript = req.body?.transcript
    const mode = req.body?.mode
    if (!Array.isArray(transcript)) {
      return res.status(400).json({ error: 'transcript must be an array' })
    }
    // ...
    res.json(
      await this.store.saveChat(ids.projectId, ids.userId, ids.chatId, transcript, mode)
    )
```

In `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunController.mjs`:
1. In `createRun`:
```js
    const { transcript, providerSettings, mode } = req.body || {}
    // ...
    this.manager
      .startRun({
        runId,
        projectId,
        userId,
        transcript,
        providerSettings,
        mode,
      })
```
2. Add `setMode`:
```js
  setMode = async (req, res) => {
    const { runId } = req.params
    const run = await this.store.getRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }

    const projectId = req.params.Project_id || req.params.project_id
    if (projectId && run.projectId !== projectId) {
      return res.status(403).json({ error: 'Cross-project run access forbidden' })
    }

    const mode = req.body?.mode
    if (!MODES.includes(mode)) {
      return res.status(400).json({ error: `Invalid mode: ${mode}. Allowed: ${MODES.join(', ')}` })
    }

    await this.manager.setMode(runId, mode)
    res.json({ ok: true })
  }
```

In `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunRouter.mjs`:
Register the mode route:
```js
    webRouter.post(
      '/ai-assist/projects/:Project_id/runs/:runId/mode',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.setMode
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistModeEndpoints.test.mjs
```
Expected: PASS

---

### Task 6: Frontend Types, Events, Reducer, and Mode Helper (`agent-mode.ts`, `agent-events.ts`, `agent-state.ts`)

**Files:**
- Create: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/agent-mode.ts`
- Modify: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/agent-events.ts`
- Modify: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/agent-state.ts`
- Test: `overleaf/services/web/modules/ai-assist/test/frontend/js/agent/agent-mode.test.ts`
- Test: `overleaf/services/web/modules/ai-assist/test/frontend/js/agent/agent-state.test.ts`

**Interfaces:**
- Consumes: None
- Produces:
  ```ts
  export type AgentMode = 'manual' | 'acceptEdits' | 'plan'
  export const AGENT_MODES: AgentMode[]
  export function nextMode(mode: AgentMode): AgentMode
  export type ApprovalKind = 'edit' | 'settings' | 'plan'
  export type PendingApproval = {
    id: string
    kind: ApprovalKind
    edit?: EditRequest
    settings?: { toolName: string; args: Record<string, unknown> }
    plan?: string
  }
  ```

- [ ] **Step 1: Write the failing tests for agent-mode and reducer**

Create `overleaf/services/web/modules/ai-assist/test/frontend/js/agent/agent-mode.test.ts`:
```ts
import { expect } from 'chai'
import {
  AGENT_MODES,
  nextMode,
  AgentMode,
} from '../../../../frontend/js/features/ai-assist/agent/agent-mode'

describe('agent-mode', () => {
  it('defines the three supported modes', () => {
    expect(AGENT_MODES).to.deep.equal(['manual', 'acceptEdits', 'plan'])
  })

  it('cycles modes with nextMode', () => {
    expect(nextMode('manual')).to.equal('acceptEdits')
    expect(nextMode('acceptEdits')).to.equal('plan')
    expect(nextMode('plan')).to.equal('manual')
    expect(nextMode('unknown' as AgentMode)).to.equal('manual')
  })
})
```

In `overleaf/services/web/modules/ai-assist/test/frontend/js/agent/agent-state.test.ts`, add:
```ts
  it('handles modeChanged event', () => {
    const initial = emptyAgentState([])
    expect(initial.mode).to.equal('manual')

    const next = reduceAgentEvent(initial, {
      type: 'modeChanged',
      mode: 'plan',
      source: 'user',
    })
    expect(next.mode).to.equal('plan')
  })

  it('stores settings and plan approvals in pendingApproval', () => {
    const initial = emptyAgentState([])

    const stateWithPlan = reduceAgentEvent(initial, {
      type: 'awaitingApproval',
      id: 'plan_call_1',
      kind: 'plan',
      plan: '# The Plan',
    })
    expect(stateWithPlan.pendingApproval).to.deep.equal({
      id: 'plan_call_1',
      kind: 'plan',
      edit: undefined,
      settings: undefined,
      plan: '# The Plan',
    })

    const stateCleared = reduceAgentEvent(stateWithPlan, {
      type: 'toolCallFinished',
      id: 'plan_call_1',
      result: { status: 'approved' },
      isError: false,
    })
    expect(stateCleared.pendingApproval).to.be.null
  })
```

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
cd overleaf/services/web && NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/agent-mode.test.ts
```
Expected: FAIL with "Cannot find module ... agent-mode"

- [ ] **Step 3: Implement agent-mode.ts, agent-events.ts, and agent-state.ts**

Create `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/agent-mode.ts`:
```ts
export type AgentMode = 'manual' | 'acceptEdits' | 'plan'

export const AGENT_MODES: AgentMode[] = ['manual', 'acceptEdits', 'plan']

export function nextMode(mode: AgentMode): AgentMode {
  const idx = AGENT_MODES.indexOf(mode)
  if (idx === -1) return 'manual'
  return AGENT_MODES[(idx + 1) % AGENT_MODES.length]
}
```

Update `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/agent-events.ts`:
```ts
import { EditRequest } from './project-handle'
import { ProviderErrorCode } from '../providers/types'
import { AgentMode } from './agent-mode'

export type ApprovalKind = 'edit' | 'settings' | 'plan'

export type SettingsApproval = {
  toolName: string
  args: Record<string, unknown>
}

export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'toolCallStarted'; id: string; name: string; args: unknown }
  | { type: 'toolCallFinished'; id: string; result: unknown; isError: boolean }
  | {
      type: 'awaitingApproval'
      id: string
      kind?: ApprovalKind
      edit?: EditRequest
      settings?: SettingsApproval
      plan?: string
    }
  | { type: 'modeChanged'; mode: AgentMode; source: 'user' | 'planApproval' }
  | { type: 'awaitingCompile'; id: string; clean?: boolean }
  | { type: 'turnFinished'; reason: 'stop' | 'aborted' | 'interrupted' }
  | {
      type: 'error'
      code: ProviderErrorCode
      message: string
      status?: number
      hint?: string
      upstreamCode?: string
      upstreamType?: string
    }
```

Update `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/agent-state.ts`:
```ts
import { AgentMode } from './agent-mode'
import { ApprovalKind, SettingsApproval } from './agent-events'

export type PendingApproval = {
  id: string
  kind: ApprovalKind
  edit?: EditRequest
  settings?: SettingsApproval
  plan?: string
}

export type AgentState = {
  transcript: TranscriptEntry[]
  running: boolean
  mode: AgentMode
  stoppedByUser: boolean
  pendingApproval: PendingApproval | null
  error: AgentError | null
}

export function emptyAgentState(
  transcript: TranscriptEntry[] = [],
  mode: AgentMode = 'manual'
): AgentState {
  return {
    transcript,
    running: false,
    mode,
    stoppedByUser: false,
    pendingApproval: null,
    error: null,
  }
}
```

In `reduceAgentEvent`:
```ts
    case 'modeChanged':
      return { ...state, mode: event.mode }

    case 'awaitingApproval':
      return {
        ...state,
        pendingApproval: {
          id: event.id,
          kind: event.kind || 'edit',
          edit: event.edit,
          settings: event.settings,
          plan: event.plan,
        },
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd overleaf/services/web && NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/agent-mode.test.ts modules/ai-assist/test/frontend/js/agent/agent-state.test.ts
```
Expected: PASS with 14 passing tests.

---

### Task 7: Background Client and Chat History Client Updates

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/background/background-run-client.ts`
- Modify: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/chat-history-client.ts`

**Interfaces:**
- Consumes: `AgentMode` from `../agent-mode`
- Produces:
  - `startBackgroundRun({ projectId, transcript, providerSettings, mode })`
  - `setBackgroundRunMode(projectId, runId, mode)`
  - `saveChat(projectId, chatId, transcript, mode)`
  - `StoredChat` has `mode?: AgentMode`

- [ ] **Step 1: Write/inspect unit test for background-run-client and chat-history-client**

In `overleaf/services/web/modules/ai-assist/test/frontend/js/agent/chat-history-client.test.ts`:
Verify that `saveChat` attaches `mode` in the JSON request body.

- [ ] **Step 2: Update background-run-client.ts**

In `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/background/background-run-client.ts`:
```ts
import { AgentMode } from '../agent-mode'

export async function startBackgroundRun({
  projectId,
  transcript,
  providerSettings,
  mode = 'manual',
}: {
  projectId: string
  transcript: TranscriptEntry[]
  providerSettings: ProviderSettings
  mode?: AgentMode
}): Promise<string> {
  const preparedTranscript = prepareTranscriptForRun(transcript)
  const res = await fetch(`/ai-assist/projects/${projectId}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getCsrfHeaders(),
    },
    body: JSON.stringify({ transcript: preparedTranscript, providerSettings, mode }),
  })
  if (!res.ok) {
    let errorMsg = `Failed to start AI run (${res.status})`
    try {
      const data = await res.json()
      if (data?.error) errorMsg = data.error
    } catch {}
    throw new Error(errorMsg)
  }
  const data = await res.json()
  return data.runId
}

export async function setBackgroundRunMode(
  projectId: string,
  runId: string,
  mode: AgentMode
): Promise<void> {
  const res = await fetch(`/ai-assist/projects/${projectId}/runs/${runId}/mode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getCsrfHeaders(),
    },
    body: JSON.stringify({ mode }),
  })
  if (!res.ok) {
    throw new Error(`Failed to change mode: ${res.status}`)
  }
}
```

- [ ] **Step 3: Update chat-history-client.ts**

In `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/chat-history-client.ts`:
```ts
import { AgentMode } from './agent-mode'

export type StoredChat = ChatSummary & {
  transcript: TranscriptEntry[]
  mode?: AgentMode
}

export function saveChat(
  projectId: string,
  chatId: string,
  transcript: TranscriptEntry[],
  mode: AgentMode = 'manual'
) {
  return putJSON<ChatSummary>(`${base(projectId)}/${chatId}`, {
    body: {
      transcript: prepareTranscriptForRun(transcript),
      mode,
    },
  })
}
```

- [ ] **Step 4: Run frontend tests**

Run:
```bash
cd overleaf/services/web && NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/agent-mode.test.ts modules/ai-assist/test/frontend/js/agent/agent-state.test.ts
```
Expected: PASS

---

### Task 8: Settings and Plan Approval Cards (`settings-approval-card.tsx`, `plan-approval-card.tsx`, `subresult-group.tsx`)

**Files:**
- Create: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/components/agent/settings-approval-card.tsx`
- Create: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/components/agent/plan-approval-card.tsx`
- Modify: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/components/agent/subresult-group.tsx`

**Interfaces:**
- Consumes:
  - `AgentMode` from `../../agent/agent-mode`
  - `MarkdownContent` from `./markdown-content`
- Produces:
  - `<SettingsApprovalCard toolName={name} args={args} onDecision={onDecision} />`
  - `<PlanApprovalCard plan={planText} onDecision={onDecision} />`

- [ ] **Step 1: Implement SettingsApprovalCard**

Create `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/components/agent/settings-approval-card.tsx`:
```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLBadge from '@/shared/components/ol/ol-badge'

export function SettingsApprovalCard({
  toolName,
  args = {},
  onDecision,
  decided,
}: {
  toolName: string
  args: Record<string, unknown>
  onDecision: (decision: { accepted: boolean; note?: string }) => void
  decided?: 'accepted' | 'rejected'
}) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const locked = Boolean(decided)

  const entries = Object.entries(args).filter(([_, v]) => v !== undefined && v !== null)

  return (
    <div className="ai-assist-edit-approval ai-assist-settings-approval">
      <div className="ai-assist-edit-approval-header">
        <span className="ai-assist-edit-approval-prompt">
          {t('ai_assist_confirm_settings_title', 'Review proposed settings change:')}
        </span>
        <OLBadge bg="info" className="ms-2">
          {t('ai_assist_settings_badge', 'settings')}
        </OLBadge>
        {decided && (
          <span className={`ai-assist-edit-decision-badge is-${decided}`}>
            {decided === 'accepted' ? '✓ Accepted' : '✗ Rejected'}
          </span>
        )}
      </div>

      <div className="ai-assist-settings-list p-2 my-2 bg-light border rounded font-monospace small">
        <div className="text-muted mb-1">{toolName}</div>
        {entries.length === 0 ? (
          <div>(no parameters)</div>
        ) : (
          entries.map(([key, val]) => (
            <div key={key} className="d-flex justify-content-between">
              <span className="text-secondary">{key}:</span>
              <span className="fw-semibold">{String(val)}</span>
            </div>
          ))
        )}
      </div>

      <OLFormControl
        type="text"
        size="sm"
        value={note}
        disabled={locked}
        placeholder={t(
          'ai_assist_reject_note_placeholder',
          'Reason for rejection (optional — guides assistant what to do next)'
        )}
        onChange={event => setNote(event.target.value)}
      />

      <div className="ai-assist-edit-approval-actions">
        <OLButton
          type="button"
          variant="secondary"
          size="sm"
          disabled={locked}
          onClick={() => onDecision({ accepted: false, note: note || undefined })}
        >
          {t('reject', 'Reject')}
        </OLButton>
        <OLButton
          type="button"
          variant="primary"
          size="sm"
          disabled={locked}
          onClick={() => onDecision({ accepted: true })}
        >
          {t('accept', 'Accept')}
        </OLButton>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Implement PlanApprovalCard**

Create `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/components/agent/plan-approval-card.tsx`:
```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLBadge from '@/shared/components/ol/ol-badge'
import { AgentMode } from '../../agent/agent-mode'
import { MarkdownContent } from './markdown-content'

export function PlanApprovalCard({
  plan,
  onDecision,
  decided,
}: {
  plan: string
  onDecision: (decision: { accepted: boolean; note?: string; nextMode?: AgentMode }) => void
  decided?: 'accepted' | 'rejected'
}) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const [showFeedback, setShowFeedback] = useState(false)
  const locked = Boolean(decided)

  return (
    <div className="ai-assist-edit-approval ai-assist-plan-approval">
      <div className="ai-assist-edit-approval-header">
        <span className="ai-assist-edit-approval-prompt">
          {t('ai_assist_plan_approval_title', 'Proposed Implementation Plan')}
        </span>
        <OLBadge bg="primary" className="ms-2">
          {t('ai_assist_plan_badge', 'plan')}
        </OLBadge>
        {decided && (
          <span className={`ai-assist-edit-decision-badge is-${decided}`}>
            {decided === 'accepted' ? '✓ Approved' : '✗ Feedback Sent'}
          </span>
        )}
      </div>

      <div className="ai-assist-plan-body p-2 my-2 border rounded bg-white text-dark max-h-60 overflow-auto">
        <MarkdownContent content={plan} />
      </div>

      {showFeedback && (
        <div className="my-2">
          <OLFormControl
            as="textarea"
            rows={3}
            size="sm"
            value={note}
            disabled={locked}
            placeholder={t(
              'ai_assist_plan_feedback_placeholder',
              'What should be adjusted in this plan?'
            )}
            onChange={e => setNote(e.target.value)}
          />
          <div className="d-flex justify-content-end gap-1 mt-1">
            <OLButton
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowFeedback(false)}
            >
              {t('cancel', 'Cancel')}
            </OLButton>
            <OLButton
              type="button"
              variant="danger"
              size="sm"
              disabled={locked || !note.trim()}
              onClick={() => onDecision({ accepted: false, note: note.trim() })}
            >
              {t('send_feedback', 'Send feedback')}
            </OLButton>
          </div>
        </div>
      )}

      {!showFeedback && (
        <div className="ai-assist-plan-approval-actions d-flex flex-wrap gap-1 mt-2">
          <OLButton
            type="button"
            variant="secondary"
            size="sm"
            disabled={locked}
            onClick={() => setShowFeedback(true)}
          >
            {t('ai_assist_plan_keep_planning', 'No, keep planning')}
          </OLButton>
          <OLButton
            type="button"
            variant="secondary"
            size="sm"
            disabled={locked}
            onClick={() => onDecision({ accepted: true, nextMode: 'manual' })}
          >
            {t('ai_assist_plan_manual_edits', 'Yes, manually approve edits')}
          </OLButton>
          <OLButton
            type="button"
            variant="primary"
            size="sm"
            disabled={locked}
            onClick={() => onDecision({ accepted: true, nextMode: 'acceptEdits' })}
          >
            {t('ai_assist_plan_auto_edits', 'Yes, auto-accept edits')}
          </OLButton>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Update subresult-group.tsx to dispatch cards**

In `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/components/agent/subresult-group.tsx`:
Import `SettingsApprovalCard` and `PlanApprovalCard`.
Create helper:
```tsx
function renderApprovalCard(
  pendingCall: any,
  approvalContext: any,
  onDecision: any
) {
  if (pendingCall.name === 'present_plan') {
    return (
      <PlanApprovalCard
        key={pendingCall.id}
        plan={pendingCall.args?.plan || ''}
        onDecision={onDecision}
      />
    )
  }
  if (pendingCall.name.startsWith('configure_')) {
    return (
      <SettingsApprovalCard
        key={pendingCall.id}
        toolName={pendingCall.name}
        args={pendingCall.args || {}}
        onDecision={onDecision}
      />
    )
  }
  return (
    <EditApprovalCard
      key={pendingCall.id}
      edit={getSafeEdit(pendingCall)}
      startLine={pendingCall.args?.startLine ?? approvalContext?.startLine ?? 1}
      onDecision={onDecision}
    />
  )
}
```
Update `pendingCallItem` to match:
```tsx
  const pendingCallItem = items.find(
    i =>
      i.type === 'tool_call' &&
      i.call &&
      i.call.id === pendingApprovalId &&
      (i.call.name === 'edit_file' ||
        i.call.name === 'create_file' ||
        i.call.name.startsWith('configure_') ||
        i.call.name === 'present_plan')
  ) as Extract<AssistantBlock, { type: 'tool_call' }> | undefined
```
And replace each occurrence of `<EditApprovalCard ... />` in `subresult-group.tsx` with:
`renderApprovalCard(pendingCallItem.call, approvalContext, onDecision)`

- [ ] **Step 4: Run frontend tests**

Run:
```bash
cd overleaf/services/web && NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/agent-state.test.ts
```
Expected: PASS

---

### Task 9: Composer Mode Selector & Hook Integration (`agent-composer.tsx`, `use-agent-run.ts`, `agent-panel.tsx`, `ai-assist.scss`)

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/hooks/use-agent-run.ts`
- Modify: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-composer.tsx`
- Modify: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx`
- Modify: `overleaf/services/web/modules/ai-assist/frontend/stylesheets/ai-assist.scss`

**Interfaces:**
- Consumes:
  - `AgentMode`, `nextMode`, `AGENT_MODES` from `../../agent/agent-mode`
  - `setBackgroundRunMode` from `../../agent/background/background-run-client`
- Produces:
  - `useAgentRun` returns `{ ...state, setMode, onDecision }`
  - `AgentComposer` props `{ mode: AgentMode, onModeChange: (m: AgentMode) => void }`
  - Composer `Shift+Tab` cycles mode

- [ ] **Step 1: Update use-agent-run.ts**

In `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/hooks/use-agent-run.ts`:
1. Import `AgentMode` and `setBackgroundRunMode`:
```ts
import { AgentMode } from '../agent/agent-mode'
import {
  // ...
  setBackgroundRunMode,
} from '../agent/background/background-run-client'
```
2. Update `onDecision`:
```ts
  const onDecision = useCallback(
    async (decision: { accepted: boolean; note?: string; nextMode?: AgentMode }) => {
      if (currentRunIdRef.current) {
        await approveBackgroundEdit(currentRunIdRef.current, decision)
      } else {
        approvalRef.current?.(decision)
        approvalRef.current = null
      }
      setApprovalContext(null)
    },
    []
  )
```
3. Add `setMode`:
```ts
  const setMode = useCallback((mode: AgentMode) => {
    setState(current => ({ ...current, mode }))
    if (currentRunIdRef.current) {
      void setBackgroundRunMode(projectIdRef.current, currentRunIdRef.current, mode).catch(err => {
        console.warn('Failed to set background run mode:', err)
      })
    }
  }, [])
```
4. Pass `state.mode` in `startBackgroundRun`:
```ts
      try {
        const runId = await startBackgroundRun({
          projectId,
          transcript,
          providerSettings: assistant.settings,
          mode: state.mode,
        })
```
5. Return `setMode` from `useAgentRun`.

- [ ] **Step 2: Update agent-composer.tsx with Mode Selector and Shift+Tab**

In `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-composer.tsx`:
1. Import `AgentMode`, `nextMode`, and Phosphor icons (`HandPalm`, `PencilSimple`, `ListChecks`):
```tsx
import { HandPalm, PencilSimple, ListChecks } from '@phosphor-icons/react'
import { AgentMode, nextMode } from '../../agent/agent-mode'
```
2. Add props:
```tsx
  mode?: AgentMode
  onModeChange?: (mode: AgentMode) => void
```
3. In `onKeyDown`:
```tsx
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      onModeChange?.(nextMode(mode || 'manual'))
      return
    }
```
4. Add ModeSelector menu in `ai-assist-composer-left-actions`:
```tsx
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const modeMenuRef = useRef<HTMLDivElement>(null)

  // Click outside to close mode menu
  useEffect(() => {
    if (!modeMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [modeMenuOpen])

  const modeConfig = {
    manual: {
      label: t('ai_assist_mode_manual', 'Manual'),
      desc: t('ai_assist_mode_manual_desc', 'Ask before every change to the project'),
      icon: <HandPalm size={14} />,
      pillClass: 'is-manual',
    },
    acceptEdits: {
      label: t('ai_assist_mode_accept_edits', 'Accept edits'),
      desc: t('ai_assist_mode_accept_edits_desc', 'Apply file edits automatically, ask for settings'),
      icon: <PencilSimple size={14} />,
      pillClass: 'is-accept-edits',
    },
    plan: {
      label: t('ai_assist_mode_plan', 'Plan mode'),
      desc: t('ai_assist_mode_plan_desc', 'Research only, then propose a plan for approval'),
      icon: <ListChecks size={14} />,
      pillClass: 'is-plan',
    },
  }

  const currentModeConfig = modeConfig[mode || 'manual']
```
Render in `ai-assist-composer-left-actions`:
```tsx
  <div className="ai-assist-mode-selector-wrapper" ref={modeMenuRef}>
    <button
      type="button"
      className={`ai-assist-mode-selector-btn ${currentModeConfig.pillClass}`}
      onClick={() => setModeMenuOpen(open => !open)}
      aria-label={t('ai_assist_select_mode', 'Select mode (Shift+Tab to cycle)')}
      title={t('ai_assist_select_mode_tooltip', 'Mode: {{label}} (Shift+Tab)', { label: currentModeConfig.label })}
    >
      {currentModeConfig.icon}
      <span className="ai-assist-mode-label">{currentModeConfig.label}</span>
    </button>
    {modeMenuOpen && (
      <div className="ai-assist-mode-dropdown-menu shadow">
        {(['manual', 'acceptEdits', 'plan'] as AgentMode[]).map(m => (
          <button
            key={m}
            type="button"
            className={`ai-assist-mode-menu-item ${m === (mode || 'manual') ? 'is-selected' : ''}`}
            onClick={() => {
              onModeChange?.(m)
              setModeMenuOpen(false)
            }}
          >
            <div className="ai-assist-mode-item-header">
              {modeConfig[m].icon}
              <span className="fw-semibold ms-1">{modeConfig[m].label}</span>
              {m === (mode || 'manual') && <span className="ms-auto text-primary">✓</span>}
            </div>
            <div className="ai-assist-mode-item-desc text-muted small">{modeConfig[m].desc}</div>
          </button>
        ))}
      </div>
    )}
  </div>
```

- [ ] **Step 3: Update agent-panel.tsx to wire mode**

In `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/components/agent/agent-panel.tsx`:
1. Destructure `setMode` from `useAgentRun`:
```tsx
  const { state, setState, run, stop, onDecision, setMode, approvalContext } = useAgentRun({
    // ...
```
2. Pass `state.mode` into `saveChat`:
```tsx
    const timer = window.setTimeout(() => {
      saveChat(projectId, chatId, transcript, state.mode).catch(() => {})
    }, 800)
```
3. In `onOpenChat`:
```tsx
      setState(emptyAgentState(chat.transcript, chat.mode || 'manual'))
```
4. In `onNewChat`:
```tsx
      setState(emptyAgentState([], 'manual'))
```
5. Pass `mode={state.mode}` and `onModeChange={setMode}` to `<AgentComposer>`:
```tsx
    <AgentComposer
      mode={state.mode}
      onModeChange={setMode}
      running={state.running}
      // ...
```

- [ ] **Step 4: Add CSS styles in ai-assist.scss**

In `overleaf/services/web/modules/ai-assist/frontend/stylesheets/ai-assist.scss`, add:
```scss
.ai-assist-mode-selector-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.ai-assist-mode-selector-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid var(--ol-border-color, #dee2e6);
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--ol-text-color, #495057);
  cursor: pointer;
  transition: all 0.15s ease-in-out;

  &:hover {
    background: var(--ol-bg-hover, rgba(0, 0, 0, 0.04));
  }

  &.is-plan {
    border-color: #0d6efd;
    color: #0d6efd;
    background: rgba(13, 110, 253, 0.06);
  }

  &.is-accept-edits {
    border-color: #198754;
    color: #198754;
    background: rgba(25, 135, 84, 0.06);
  }
}

.ai-assist-mode-dropdown-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 6px;
  width: 260px;
  background: var(--ol-bg-surface, #ffffff);
  border: 1px solid var(--ol-border-color, #dee2e6);
  border-radius: 8px;
  padding: 4px;
  z-index: 1050;
}

.ai-assist-mode-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;

  &:hover {
    background: var(--ol-bg-hover, rgba(0, 0, 0, 0.05));
  }

  &.is-selected {
    background: var(--ol-bg-selected, rgba(13, 110, 253, 0.08));
  }
}

.ai-assist-plan-body {
  max-height: 250px;
  overflow-y: auto;
  font-size: 12px;
}
```

- [ ] **Step 5: Run tests to verify frontend compiles and passes**

Run:
```bash
cd overleaf/services/web && NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/agent-mode.test.ts modules/ai-assist/test/frontend/js/agent/agent-state.test.ts
```
Expected: PASS

---

### Task 10: Complete Verification & Test Suite

**Files:**
- Test: All unit test files for `ai-assist`

- [ ] **Step 1: Run full ai-assist backend unit tests**

Run:
```bash
cd overleaf/services/web && XDG_DATA_HOME="$TMPDIR/xdg" /home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run modules/ai-assist/test/unit/src/
```
Expected: PASS with 100% tests passing across all ai-assist test files.

- [ ] **Step 2: Run all frontend unit tests**

Run:
```bash
cd overleaf/services/web && NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/
```
Expected: PASS with 100% tests passing.

- [ ] **Step 3: Verify git status is clean of unintended changes**

Run:
```bash
git status --short
```
Verify that all changed and created files are within the `ai-assist` scope, with no untracked symlinks or stray build artifacts.
DO NOT run `git commit` or `git push`.

- [ ] **Step 4: Inform user about Dev Server Redeployment**

Per project memory `redeploy-dev-server-after-ui-changes.md`, notify the user that to see the UI changes in the browser, the dev server can be redeployed using docker.
