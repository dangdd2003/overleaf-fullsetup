# AI Assist Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL GIT RULE:** Under project instructions, NEVER run `git commit`, `git push`, branch creation, or stash autonomously. Leave all file changes unstaged/uncommitted in the working tree. Git commits are executed only when the user explicitly instructs.

**Goal:** Implement strict single-project boundary enforcement and security hardening for Overleaf AI Assist by securing run endpoints with project authorization middleware, blocking SSRF to internal Docker containers and cloud metadata, enforcing strict user identity attribution, generating 128-bit run IDs, and blocking path traversal.

**Architecture:** 
1. Mount background run endpoints (`stream`, `stop`, `approve`) under project-scoped routes (`/ai-assist/projects/:Project_id/runs/:runId/...`) guarded by `AuthorizationMiddleware` (`ensureUserCanReadProjectContent` / `ensureUserCanWriteProjectContent`), with cross-project assertion `run.projectId === req.params.Project_id`.
2. Add `validateSafeProviderBaseUrl` in `AiAssistProviders.mjs` to block SSRF targeting internal Docker hostnames (`mongo`, `redis`, `clsi`, `docstore`, `filestore`, etc.), loopbacks, and cloud metadata (`169.254.169.254`), while allowing valid external endpoints and the host bridge gateway.
3. Remove `owner_ref` fallback in `AiAssistTools._resolveValidUserId` to enforce non-repudiation and prevent preference tampering.
4. Increase `runId` entropy to 128 bits (`crypto.randomBytes(16)`).
5. Synchronize `background-run-client.ts` to use project-scoped endpoints.

**Tech Stack:** Node.js (ES Modules), Express.js, Overleaf AuthorizationMiddleware, Redis, Mocha/Vitest, TypeScript.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-15-ai-assist-security-hardening-design.md`

## Global Constraints

- Never commit changes with git autonomously; leave changes in working tree.
- Do not add external dependencies when built-in Node.js / URL / regex tools suffice.
- Preserve backward-compatibility for in-flight legacy routes (`/ai-assist/runs/:runId/*`) with inline authorization checks.
- All backend files use ES Module syntax (`.mjs`).

---

### Task 1: SSRF Defense & Safe Base URL Validation

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistProviders.mjs`
- Test: `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs`

**Interfaces:**
- Consumes: `providerSettings.baseUrl` / `providerSettings.baseURL`
- Produces: `validateSafeProviderBaseUrl(rawUrl)` exported from `AiAssistProviders.mjs`

- [ ] **Step 1: Write the failing tests for `validateSafeProviderBaseUrl`**

Add unit tests in `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs`:

```javascript
import { expect } from 'chai'
import { validateSafeProviderBaseUrl, ProviderError } from '../../../app/src/AiAssistProviders.mjs'

describe('validateSafeProviderBaseUrl', function () {
  it('allows standard public cloud LLM endpoints', function () {
    expect(() => validateSafeProviderBaseUrl('https://api.openai.com/v1')).to.not.throw()
    expect(() => validateSafeProviderBaseUrl('https://api.anthropic.com')).to.not.throw()
    expect(() => validateSafeProviderBaseUrl('https://generativelanguage.googleapis.com')).to.not.throw()
  })

  it('allows Docker host gateway for local Ollama', function () {
    const gateway = process.env.DOCKER_HOST_GATEWAY || '172.20.0.1'
    expect(() => validateSafeProviderBaseUrl(`http://${gateway}:11434`)).to.not.throw()
  })

  it('blocks internal Docker container hostnames', function () {
    const blocked = [
      'http://mongo:27017',
      'http://mongodb:27017',
      'http://redis:6379',
      'http://clsi:3013',
      'http://filestore:3009',
      'http://docstore:3016',
      'http://document-updater:10000',
      'http://chat:3000',
      'http://real-time:3026',
      'http://spelling:3005',
      'http://notifications:3042',
      'http://git-bridge:3010',
      'http://project-history:3054',
    ]
    for (const url of blocked) {
      expect(() => validateSafeProviderBaseUrl(url), `Should block ${url}`).to.throw(ProviderError)
    }
  })

  it('blocks cloud metadata endpoints', function () {
    expect(() => validateSafeProviderBaseUrl('http://169.254.169.254/latest/meta-data')).to.throw(ProviderError)
    expect(() => validateSafeProviderBaseUrl('http://metadata.google.internal/computeMetadata/v1')).to.throw(ProviderError)
  })

  it('blocks non-HTTP protocols', function () {
    expect(() => validateSafeProviderBaseUrl('file:///etc/passwd')).to.throw(ProviderError)
    expect(() => validateSafeProviderBaseUrl('gopher://127.0.0.1:6379')).to.throw(ProviderError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs
```
Expected: FAIL with `validateSafeProviderBaseUrl is not a function`.

- [ ] **Step 3: Implement `validateSafeProviderBaseUrl` in `AiAssistProviders.mjs`**

Add to `overleaf/services/web/modules/ai-assist/app/src/AiAssistProviders.mjs`:

```javascript
const BLOCKED_INTERNAL_HOSTS = new Set([
  'mongo',
  'mongodb',
  'redis',
  'clsi',
  'docstore',
  'document-updater',
  'filestore',
  'chat',
  'real-time',
  'spelling',
  'contacts',
  'notifications',
  'git-bridge',
  'project-history',
  'metadata.google.internal',
])

export function validateSafeProviderBaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return true
  }

  let parsed
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new ProviderError('Invalid provider URL format', { code: 'invalidProviderUrl', status: 400 })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProviderError(`Forbidden protocol '${parsed.protocol}'. Only http and https are permitted.`, {
      code: 'invalidProviderUrl',
      status: 400,
    })
  }

  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_INTERNAL_HOSTS.has(hostname) || hostname.endsWith('.internal')) {
    throw new ProviderError(`Access to internal service '${hostname}' is forbidden.`, {
      code: 'restrictedProviderUrl',
      status: 400,
    })
  }

  // Block link-local and cloud metadata
  if (hostname === '169.254.169.254' || hostname.startsWith('169.254.')) {
    throw new ProviderError('Access to cloud metadata endpoints is forbidden.', {
      code: 'restrictedProviderUrl',
      status: 400,
    })
  }

  return true
}
```

In `createProviderClient(settings)`:
```javascript
export function createProviderClient(settings = {}) {
  const url = settings.baseUrl || settings.baseURL
  if (url) {
    validateSafeProviderBaseUrl(url)
  }
  // ... continue instantiating provider client
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistProviders.test.mjs
```
Expected: PASS.

---

### Task 2: Controller Validation, High Entropy Run IDs, & Cross-Project Assertion

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunController.mjs`
- Test: `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs`

**Interfaces:**
- Consumes: `validateSafeProviderBaseUrl`, `crypto.randomBytes(16)`, `req.params.Project_id`
- Produces: Hardened `createRun`, `streamRun`, `stopRun`, `approve`

- [ ] **Step 1: Write failing tests for controller security enhancements**

Add tests in `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs`:

```javascript
it('rejects createRun with 400 when providerSettings.baseUrl is internal service', async function () {
  const req = {
    params: { Project_id: 'proj-1' },
    session: { user: { _id: 'user-1' } },
    body: {
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', baseUrl: 'http://mongo:27017', apiKey: 'key' },
    },
  }
  const res = {
    json: sinon.stub(),
    status: sinon.stub().returnsThis(),
  }

  await controller.createRun(req, res)
  expect(res.status.calledWith(400)).to.be.true
  expect(mockManager.startRun.called).to.be.false
})

it('generates runId with 128-bit hex entropy', async function () {
  const req = {
    params: { Project_id: 'proj-1' },
    session: { user: { _id: 'user-1' } },
    body: {
      transcript: [{ role: 'user', content: 'test' }],
      providerSettings: { type: 'openai', apiKey: 'key' },
    },
  }
  const res = { json: sinon.stub(), status: sinon.stub().returnsThis() }

  await controller.createRun(req, res)
  const runId = res.json.firstCall.args[0].runId
  // Format: run_<timestamp>_<32 hex chars>
  const parts = runId.split('_')
  expect(parts[0]).to.equal('run')
  expect(parts[2]).to.have.lengthOf(32)
})

it('rejects streamRun with 403 when route Project_id does not match run.projectId', async function () {
  const req = {
    params: { Project_id: 'attacker-proj', runId: 'run-1' },
    query: {},
    session: { user: { _id: 'user-1' } },
    on: sinon.stub(),
  }
  const res = {
    json: sinon.stub(),
    status: sinon.stub().returnsThis(),
  }

  // mockStore.getRun returns projectId: 'p1'
  await controller.streamRun(req, res)
  expect(res.status.calledWith(403)).to.be.true
  expect(res.json.firstCall.args[0].error).to.include('forbidden')
})

it('rejects stopRun with 403 when route Project_id does not match run.projectId', async function () {
  const req = {
    params: { Project_id: 'mismatched-proj', runId: 'run-1' },
    session: { user: { _id: 'user-1' } },
  }
  const res = { json: sinon.stub(), status: sinon.stub().returnsThis() }

  await controller.stopRun(req, res)
  expect(res.status.calledWith(403)).to.be.true
  expect(mockManager.stopRun.called).to.be.false
})

it('rejects approve with 403 when route Project_id does not match run.projectId', async function () {
  const req = {
    params: { Project_id: 'mismatched-proj', runId: 'run-1' },
    body: { accepted: true },
    session: { user: { _id: 'user-1' } },
  }
  const res = { json: sinon.stub(), status: sinon.stub().returnsThis() }

  await controller.approve(req, res)
  expect(res.status.calledWith(403)).to.be.true
  expect(mockManager.approveEdit.called).to.be.false
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs
```
Expected: FAIL.

- [ ] **Step 3: Implement controller hardening in `AiAssistRunController.mjs`**

Modify `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunController.mjs`:
1. Import `validateSafeProviderBaseUrl` from `./AiAssistProviders.mjs`.
2. In `createRun`:
   - Validate `providerSettings.baseUrl` / `providerSettings.baseURL`. If invalid, return `res.status(400).json({ error: err.message })`.
   - Update runId: `const runId = 'run_' + Date.now() + '_' + crypto.randomBytes(16).toString('hex')`.
3. In `streamRun`, `stopRun`, `approve`:
   - Fetch `run = await this.store.getRun(runId)`. If not found, return 404.
   - Extract `projectId = req.params.Project_id || req.params.project_id`.
   - If `projectId && run.projectId !== projectId`, return `res.status(403).json({ error: 'Cross-project run access forbidden' })`.
   - For legacy route invocation where `!projectId`:
     ```javascript
     const loggedInUserId = SessionManager.getLoggedInUserId(req.session)
     // Fallback to checking user read/write access via AuthorizationManager if available
     ```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunController.test.mjs
```
Expected: PASS.

---

### Task 3: Project-Scoped Routing & Authorization Middleware

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunRouter.mjs`
- Test: `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistRunRouter.test.mjs`

**Interfaces:**
- Consumes: `webRouter`, `AuthorizationMiddleware`, `AuthenticationController`
- Produces: Route definitions under `/ai-assist/projects/:Project_id/runs/...`

- [ ] **Step 1: Write unit test for `AiAssistRunRouter.mjs`**

Create `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistRunRouter.test.mjs`:

```javascript
import { expect } from 'chai'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import routerModule from '../../../app/src/AiAssistRunRouter.mjs'

describe('AiAssistRunRouter', function () {
  let webRouter
  let origEnabled

  beforeEach(function () {
    origEnabled = Settings.aiAssist?.enabled
    Settings.aiAssist = { ...(Settings.aiAssist || {}), enabled: true }
    webRouter = {
      get: sinon.stub(),
      post: sinon.stub(),
    }
  })

  afterEach(function () {
    Settings.aiAssist.enabled = origEnabled
  })

  it('registers project-scoped routes with authorization middleware', async function () {
    await routerModule.apply(webRouter)

    const postRoutes = webRouter.post.args.map(call => call[0])
    const getRoutes = webRouter.get.args.map(call => call[0])

    expect(postRoutes).to.include('/ai-assist/projects/:Project_id/runs')
    expect(getRoutes).to.include('/ai-assist/projects/:Project_id/runs/:runId/stream')
    expect(postRoutes).to.include('/ai-assist/projects/:Project_id/runs/:runId/stop')
    expect(postRoutes).to.include('/ai-assist/projects/:Project_id/runs/:runId/approve')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunRouter.test.mjs
```
Expected: FAIL.

- [ ] **Step 3: Update route definitions in `AiAssistRunRouter.mjs`**

In `overleaf/services/web/modules/ai-assist/app/src/AiAssistRunRouter.mjs`:

```javascript
import Settings from '@overleaf/settings'

export default {
  async apply(webRouter) {
    if (!Settings.aiAssist?.enabled) return

    const { default: AiAssistRunController } = await import('./AiAssistRunController.mjs')
    const { default: AuthenticationController } = await import('../../../../app/src/Features/Authentication/AuthenticationController.mjs')
    const { default: AuthorizationMiddleware } = await import('../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs')

    // 1. Primary project-scoped routes with strict authorization
    webRouter.post(
      '/ai-assist/projects/:Project_id/runs',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.createRun
    )

    webRouter.get(
      '/ai-assist/projects/:Project_id/runs/:runId/stream',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProjectContent,
      AiAssistRunController.streamRun
    )

    webRouter.post(
      '/ai-assist/projects/:Project_id/runs/:runId/stop',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.stopRun
    )

    webRouter.post(
      '/ai-assist/projects/:Project_id/runs/:runId/approve',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.approve
    )

    // 2. Legacy fallback routes (controller performs inline authorization check)
    webRouter.get(
      '/ai-assist/runs/:runId/stream',
      AuthenticationController.requireLogin(),
      AiAssistRunController.streamRun
    )

    webRouter.post(
      '/ai-assist/runs/:runId/stop',
      AuthenticationController.requireLogin(),
      AiAssistRunController.stopRun
    )

    webRouter.post(
      '/ai-assist/runs/:runId/approve',
      AuthenticationController.requireLogin(),
      AiAssistRunController.approve
    )
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRunRouter.test.mjs
```
Expected: PASS.

---

### Task 4: Strict User Identity Resolution & Path Traversal Containment in Tools

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/app/src/AiAssistTools.mjs`
- Test: `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`

**Interfaces:**
- Consumes: `rawUserId`, `args.path`
- Produces: Strict `_resolveValidUserId`, path normalization

- [ ] **Step 1: Write failing tests for identity and path traversal in `AiAssistTools.test.mjs`**

Add tests to `overleaf/services/web/modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`:

```javascript
it('rejects execution when userId is missing or invalid without falling back to owner_ref', async function () {
  const tools = new AiAssistTools({
    projectGetter: {
      getProject: sinon.stub().resolves({ owner_ref: '507f1f77bcf86cd799439011' }),
    },
  })

  const result = await tools.execute('edit_file', { path: 'main.tex', oldText: 'a', newText: 'b' }, {
    projectId: '507f1f77bcf86cd799439012',
    userId: null,
  })

  expect(result.error).to.include('user')
  expect(tools.projectGetter.getProject.called).to.be.false
})

it('rejects path traversal attempts in read_file and edit_file', async function () {
  const tools = new AiAssistTools()
  const badPaths = ['../../etc/passwd', '../secret.tex', '/../root.tex']

  for (const path of badPaths) {
    const readResult = await tools.execute('read_file', { path }, {
      projectId: '507f1f77bcf86cd799439012',
      userId: '507f1f77bcf86cd799439011',
    })
    expect(readResult.error, `read_file should reject ${path}`).to.include('traversal')

    const editResult = await tools.execute('edit_file', { path, oldText: 'x', newText: 'y' }, {
      projectId: '507f1f77bcf86cd799439012',
      userId: '507f1f77bcf86cd799439011',
    })
    expect(editResult.error, `edit_file should reject ${path}`).to.include('traversal')
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs
```
Expected: FAIL.

- [ ] **Step 3: Implement strict identity and path validation in `AiAssistTools.mjs`**

Modify `_resolveValidUserId` in `overleaf/services/web/modules/ai-assist/app/src/AiAssistTools.mjs`:
```javascript
  async _resolveValidUserId(projectId, userId) {
    if (userId && /^[0-9a-f]{24}$/i.test(String(userId))) {
      return String(userId)
    }
    return null
  }
```
In `execute`:
```javascript
  async execute(name, args = {}, { projectId, userId: rawUserId }) {
    const userId = await this._resolveValidUserId(projectId, rawUserId)
    if (!userId) {
      return { error: 'A valid authenticated user context is required to execute tools.' }
    }

    // Path sanitization for file operations
    if (args.path && typeof args.path === 'string') {
      const normalized = args.path.replace(/\\/g, '/').replace(/^\/+/, '')
      if (normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
        return { error: 'Path traversal forbidden: file path cannot reference parent directories.' }
      }
    }
    // ... continue execution
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistTools.test.mjs
```
Expected: PASS.

---

### Task 5: Frontend Client Synchronization

**Files:**
- Modify: `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/background/background-run-client.ts`
- Test: `overleaf/services/web/modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts`

**Interfaces:**
- Consumes: `projectId`, `runId`
- Produces: Project-scoped `EventSource` URL

- [ ] **Step 1: Write unit test for project-scoped stream URL**

Add test in `overleaf/services/web/modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts`:

```typescript
it('connects to project-scoped stream endpoint', () => {
  const EventSourceSpy = vi.fn()
  globalThis.EventSource = EventSourceSpy as any

  connectRunStream({
    runId: 'run-123',
    projectId: 'proj-456',
    onEvent: () => {},
    onDone: () => {},
    onError: () => {},
  })

  expect(EventSourceSpy).toHaveBeenCalledWith('/ai-assist/projects/proj-456/runs/run-123/stream?since=0')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Update `background-run-client.ts` to use project-scoped URLs**

In `overleaf/services/web/modules/ai-assist/frontend/js/features/ai-assist/agent/background/background-run-client.ts`:
Change line 82:
```typescript
  const eventSource = new EventSource(`/ai-assist/projects/${projectId}/runs/${runId}/stream?since=${since}`)
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/frontend/js/agent/background-run-client.test.ts
```
Expected: PASS.

---

### Task 6: Full Regression & Security Suite Verification

**Files:**
- Test all backend and frontend `ai-assist` tests.

- [ ] **Step 1: Run all unit tests in `modules/ai-assist/test/unit/src`**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
```
Expected: All tests PASS.

- [ ] **Step 2: Run all frontend unit tests in `modules/ai-assist/test/frontend/js`**

Run:
```bash
cd overleaf/services/web && node ../../node_modules/.bin/vitest run modules/ai-assist/test/frontend/js
```
Expected: All tests PASS.
