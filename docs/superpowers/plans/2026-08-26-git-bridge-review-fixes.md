# Git Bridge Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 15 security, correctness, and test-alignment defects identified by Codex review and xhigh code review in the git-bridge integration.

**Architecture:** All fixes target existing files in the `services/web/app/src/Features/GitBridge/` module, the `server-ce/` deployment config, and the `services/web/test/` test suites. No new modules — the changes harden existing auth middleware, fix data-handling bugs in snapshot/push flows, and align test assertions with current component behavior.

**Tech Stack:** Node.js (ESM, Express 4), Vitest + Sinon (unit tests), React Testing Library (frontend tests), nginx/shell (server-ce), Dockerfile (server-ce).

**Spec:** `docs/superpowers/plans/2026-08-26-git-bridge-review-fixes.md` (this document)

## Global Constraints

- All backend code is ESM (`.mjs` files) — use `import`/`export`, not `require`.
- Error handling follows the Overleaf convention: `import Errors from '../Errors/Errors.js'`, use `Errors.NotFoundError`.
- Authorization uses `AuthorizationManager.promises.canUserReadProject(userId, projectId, token)` and `AuthorizationManager.promises.canUserWriteProjectContent(userId, projectId, token)`.
- Unit tests use Vitest (`describe`, `it`, `expect` from `vitest`) with Sinon stubs.
- Frontend tests use React Testing Library with `getByRole`, `getByText`, etc.
- Run unit tests with: `node --test --import ./test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/` (or `corepack yarn test:unit:web` if available).

---

## File Structure

### Files Modified

| File | Responsibility | Changes |
|------|---------------|---------|
| `services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs` | Auth middleware + route handlers | Fix auth bypass, empty password leak, NotFoundError handling |
| `services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs` | Snapshot generation + push processing | Fix batch doc map, callback fallback, push ordering, folder deletion, entity fetch error handling |
| `services/web/app/src/Features/GitBridge/PersonalAccessTokenController.mjs` | PAT CRUD endpoints | Add try/catch error handling |
| `server-ce/Dockerfile` | Production image build | Fix Node version threshold |
| `server-ce/init_scripts/200_nginx_config_template.sh` | Nginx config generation | Case-insensitive GIT_BRIDGE_ENABLED |
| `server-ce/nginx/git-bridge.conf.template` | Nginx proxy config | Handle /git (no trailing slash) |
| `services/web/test/unit/src/Features/GitBridge/GitBridgeRouter.test.mjs` | Router unit tests | Remove stale proxy assertions |
| `services/web/frontend/js/features/ide-react/components/modals/git-bridge-modal.tsx` | (no code change — test-only fix) | — |
| `services/web/test/frontend/features/ide-react/git-bridge-modal.test.tsx` | Modal frontend tests | Fix DOM selectors and copy |
| `services/web/test/frontend/features/settings/components/linking/git-tokens-widget.test.tsx` | Token widget frontend tests | Fix selectors and labels |

### Test Files

| File | Tests Added/Modified |
|------|---------------------|
| `services/web/test/unit/src/Features/GitBridge/GitBridgeApiController.test.mjs` | Add auth middleware tests |
| `services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs` | Add batch-doc-map and push-ordering tests |

---

## Task 1: Fix auth bypass in requireGitBridgeAuth and requireProjectRead

**Files:**
- Modify: `services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs:41-73`

**Interfaces:**
- Consumes: `resolveAuthUser(req)` → `string | null` (already defined at line 22)
- Produces: `requireGitBridgeAuth(req, res, next)` — rejects with 401 if no user; sets `req.gitBridgeUserId`; calls `next()` only on success
- Produces: `requireProjectRead(req, res, next)` — rejects with 401 if no user; rejects with 403 if no read access; calls `next()` only on success

- [ ] **Step 1: Write failing tests for requireGitBridgeAuth rejecting unauthenticated requests**

Add to `services/web/test/unit/src/Features/GitBridge/GitBridgeApiController.test.mjs`:

```javascript
describe('requireGitBridgeAuth', function () {
  let next
  beforeEach(function () {
    next = sinon.spy()
    req = {
      headers: {},
      params: { projectId },
      body: {},
    }
  })

  it('rejects with 401 when no auth credentials present', async function () {
    await GitBridgeApiController.requireGitBridgeAuth(req, res, next)
    expect(statusCalls[0]).toBe(401)
    expect(jsonCalls[0]).toEqual({
      code: 'unauthorized',
      message: 'Valid authentication required',
    })
    expect(next.called).toBe(false)
  })

  it('calls next() when session user present', async function () {
    req.session = { user: { _id: 'user-123' } }
    await GitBridgeApiController.requireGitBridgeAuth(req, res, next)
    expect(next.calledOnce).toBe(true)
    expect(req.gitBridgeUserId).toBe('user-123')
  })
})

describe('requireProjectRead', function () {
  let next
  beforeEach(function () {
    next = sinon.spy()
    req = {
      headers: {},
      params: { projectId },
      body: {},
    }
  })

  it('rejects with 401 when no auth credentials present', async function () {
    await GitBridgeApiController.requireProjectRead(req, res, next)
    expect(statusCalls[0]).toBe(401)
    expect(next.called).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeApiController.test.mjs`
Expected: FAIL — `requireGitBridgeAuth` calls `next()` unconditionally instead of returning 401

- [ ] **Step 3: Fix requireGitBridgeAuth to reject unauthenticated**

In `services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs`, replace the `requireGitBridgeAuth` function (lines 41-47):

```javascript
async function requireGitBridgeAuth(req, res, next) {
  const userId = await resolveAuthUser(req)
  if (!userId) {
    return res
      .status(401)
      .json({ code: 'unauthorized', message: 'Valid authentication required' })
  }
  req.gitBridgeUserId = userId
  return next()
}
```

- [ ] **Step 4: Fix requireProjectRead to reject unauthenticated before authz check**

Replace the `requireProjectRead` function (lines 49-73):

```javascript
async function requireProjectRead(req, res, next) {
  const userId = await resolveAuthUser(req)
  const { projectId } = req.params

  if (!userId) {
    return res
      .status(401)
      .json({ code: 'unauthorized', message: 'Valid authentication required' })
  }
  req.gitBridgeUserId = userId

  try {
    const canRead =
      await AuthorizationManager.promises.canUserReadProject(
        userId,
        projectId,
        null
      )
    if (!canRead) {
      return res
        .status(403)
        .json({ code: 'forbidden', message: 'No read access to project' })
    }
    return next()
  } catch (err) {
    if (err instanceof Errors.NotFoundError) {
      return res
        .status(404)
        .json({ code: 'invalidProject', message: 'Project not found' })
    }
    logger.error({ err, projectId, userId }, 'error checking read access')
    return res.status(500).json({ code: 'error', message: err.message })
  }
}
```

Add import at top of file (after line 3):

```javascript
import Errors from '../Errors/Errors.js'
```

- [ ] **Step 5: Fix requireProjectWrite NotFoundError handling**

In `requireProjectWrite` (lines 75-104), add NotFoundError check in catch block:

```javascript
  } catch (err) {
    if (err instanceof Errors.NotFoundError) {
      return res
        .status(404)
        .json({ code: 'invalidProject', message: 'Project not found' })
    }
    logger.error({ err, projectId, userId }, 'error checking write access')
    return res.status(500).json({ code: 'error', message: err.message })
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeApiController.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs \
      services/web/test/unit/src/Features/GitBridge/GitBridgeApiController.test.mjs
git commit -m "[git-bridge] fix auth bypass in requireGitBridgeAuth and requireProjectRead

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Fix empty-password token extraction and NotFoundError handling

**Files:**
- Modify: `services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs:6-20`

**Interfaces:**
- Produces: `extractToken(req)` → `string | null` — returns `null` for Basic auth with empty password

- [ ] **Step 1: Write failing test for empty-password Basic auth**

Add to `GitBridgeApiController.test.mjs`:

```javascript
describe('extractToken (via requireGitBridgeAuth)', function () {
  let next
  beforeEach(function () {
    next = sinon.spy()
    req = { headers: {}, params: { projectId }, body: {} }
  })

  it('rejects Basic auth with empty password (user=git, pass=empty)', async function () {
    // Authorization: Basic base64("git:")
    const encoded = Buffer.from('git:').toString('base64')
    req.headers.authorization = `Basic ${encoded}`
    await GitBridgeApiController.requireGitBridgeAuth(req, res, next)
    expect(statusCalls[0]).toBe(401)
    expect(next.called).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeApiController.test.mjs`
Expected: FAIL — `extractToken` returns `'git'` instead of `null`

- [ ] **Step 3: Fix extractToken to reject empty passwords**

In `GitBridgeApiController.mjs`, replace the `extractToken` function (lines 6-20):

```javascript
function extractToken(req) {
  const authHeader = req.headers?.authorization || ''
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const [user, ...pass] = decoded.split(':')
    const password = pass.join(':')
    if (password) return password.trim()
    return null
  }
  if (req.query?.access_token) {
    return String(req.query.access_token).trim()
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeApiController.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs \
      services/web/test/unit/src/Features/GitBridge/GitBridgeApiController.test.mjs
git commit -m "[git-bridge] reject empty-password Basic auth in extractToken

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Fix batch doc array-to-map conversion in getSnapshotForVersion

**Files:**
- Modify: `services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs:235-244`

**Interfaces:**
- Consumes: `DocstoreManager.promises.getAllDocs(projectId)` → `Array<{_id, lines, ...}>`
- Produces: `allDocsMap` — `Object<string, {lines: string[]}>` keyed by `doc._id.toString()`

- [ ] **Step 1: Write failing test for batch doc map conversion**

Add to `services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs`:

```javascript
describe('getSnapshotForVersion batch doc map', function () {
  it('uses batch docs keyed by _id string', async function () {
    const projectId = 'batch-test-project'
    setMockProject(async () => ({
      _id: projectId,
      version: 1,
      rootFolder: [
        {
          _id: 'root',
          name: 'rootFolder',
          docs: [
            { _id: 'doc-a', name: 'main.tex' },
            { _id: 'doc-b', name: 'other.tex' },
          ],
          fileRefs: [],
          folders: [],
        },
      ],
    }))

    DocstoreManager.promises.getAllDocVersions = async () => [
      { _id: 'doc-a', version: 1 },
      { _id: 'doc-b', version: 1 },
    ]

    let getAllDocsCalled = false
    let getDocCallCount = 0
    DocstoreManager.promises.getAllDocs = async () => {
      getAllDocsCalled = true
      return [
        { _id: 'doc-a', lines: ['line 1', 'line 2'] },
        { _id: 'doc-b', lines: ['hello'] },
      ]
    }
    DocstoreManager.promises.getDoc = async () => {
      getDocCallCount++
      return { lines: ['fallback'] }
    }

    const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(
      projectId,
      undefined
    )

    expect(getAllDocsCalled).toBe(true)
    // Should NOT fall back to individual getDoc calls when batch succeeds
    expect(getDocCallCount).toBe(0)
    expect(snapshot.srcs).toContainEqual(['line 1\nline 2', 'main.tex'])
    expect(snapshot.srcs).toContainEqual(['hello', 'other.tex'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs`
Expected: FAIL — `getDocCallCount` > 0 because `allDocsMap` is an array, not a map

- [ ] **Step 3: Fix batch doc conversion to ID-keyed map**

In `GitBridgeSnapshotManager.mjs`, replace lines 235-244:

```javascript
    let allDocsMap = {}
    try {
      const getAllDocsFn =
        DocstoreManager.promises?.getAllDocs || DocstoreManager.getAllDocs
      if (typeof getAllDocsFn === 'function') {
        const batchDocs = await getAllDocsFn(projectId)
        if (Array.isArray(batchDocs)) {
          for (const doc of batchDocs) {
            if (doc?._id) {
              allDocsMap[doc._id.toString()] = doc
            }
          }
        } else if (batchDocs && typeof batchDocs === 'object') {
          allDocsMap = batchDocs
        }
      }
    } catch (err) {
      logger.warn(
        { err, projectId },
        'error fetching batch docs from docstore, falling back to individual'
      )
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs \
      services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs
git commit -m "[git-bridge] convert batch docs array to ID-keyed map

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Fix DocstoreManager.getDoc callback fallback

**Files:**
- Modify: `services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs:271-277`

**Interfaces:**
- Consumes: `DocstoreManager.getDoc(projectId, docId, callback)` — callback-style API

- [ ] **Step 1: Write failing test for callback fallback**

Add to `GitBridgeSnapshotManager.test.mjs`:

```javascript
describe('getSnapshotForVersion callback fallback', function () {
  it('uses callback-style getDoc when promises API unavailable', async function () {
    const projectId = 'callback-fallback-project'
    setMockProject(async () => ({
      _id: projectId,
      version: 1,
      rootFolder: [
        {
          _id: 'root',
          name: 'rootFolder',
          docs: [{ _id: 'doc-c', name: 'main.tex' }],
          fileRefs: [],
          folders: [],
        },
      ],
    }))

    DocstoreManager.promises.getAllDocVersions = async () => []
    DocstoreManager.promises.getAllDocs = undefined
    DocstoreManager.promises.getDoc = undefined
    DocstoreManager.getDoc = (projectId, docId, callback) => {
      callback(null, { lines: ['callback content'] })
    }

    const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(
      projectId,
      undefined
    )

    expect(snapshot.srcs).toContainEqual(['callback content', 'main.tex'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs`
Expected: FAIL — `DocstoreManager.getDoc` is called without callback, returns `undefined`

- [ ] **Step 3: Fix callback fallback to pass a proper callback**

In `GitBridgeSnapshotManager.mjs`, replace the fallback `getDoc` branch (around line 271-277):

```javascript
            } else {
              const docData = await new Promise((resolve, reject) => {
                DocstoreManager.getDoc(projectId, docIdStr, (err, doc) =>
                  err ? reject(err) : resolve(doc)
                )
              })
              lines = docData?.lines !== undefined ? docData.lines : docData
            }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs \
      services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs
git commit -m "[git-bridge] fix DocstoreManager.getDoc callback fallback

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Reorder processPush — download before delete

**Files:**
- Modify: `services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs:334-401`

**Interfaces:**
- No interface changes — internal reordering of `processPush` logic

- [ ] **Step 1: Write failing test for push ordering**

Add to `GitBridgeSnapshotManager.test.mjs`:

```javascript
describe('processPush download-before-delete ordering', function () {
  it('downloads all files before deleting removed entities', async function () {
    const projectId = 'ordering-test-project'
    const callOrder = []

    setMockProject(async () => ({
      _id: projectId,
      version: 5,
      rootFolder: [
        {
          _id: 'root',
          name: 'rootFolder',
          docs: [{ _id: 'old-doc', name: 'old-file.tex' }],
          fileRefs: [],
          folders: [],
        },
      ],
    }))

    DocstoreManager.promises.getAllDocVersions = async () => []

    // Mock EditorController to track call order
    EditorController.promises.deleteEntityWithPath = async () => {
      callOrder.push('delete')
    }
    EditorController.promises.upsertDocWithPath = async () => {
      callOrder.push('upsert')
    }

    globalThis.fetch = async (url) => {
      callOrder.push('fetch')
      return {
        ok: true,
        arrayBuffer: async () =>
          new ArrayBuffer(0),
      }
    }

    const files = [
      { name: 'new-file.tex', url: 'http://git-bridge/raw/new-file.tex' },
    ]

    await GitBridgeSnapshotManager.processPush(
      projectId,
      'user-1',
      files,
      null
    )

    // All upserts (fetches) should happen before any delete
    const firstDeleteIdx = callOrder.indexOf('delete')
    const lastFetchIdx = callOrder.lastIndexOf('fetch')
    expect(lastFetchIdx).toBeLessThan(firstDeleteIdx)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs`
Expected: FAIL — deletes happen before fetches in current code

- [ ] **Step 3: Reorder processPush — move delete loop after download loop**

In `GitBridgeSnapshotManager.mjs`, restructure `processPush` so the order is:
1. Collect incoming file paths
2. Fetch all files, write to temp dir, upsert docs/files
3. Then fetch existing entities and delete removed ones

Move the "Delete files removed from git" block (lines 344-401) to AFTER the "Process added or modified files" block (lines 403-502). The new structure:

```javascript
    try {
      // Collect incoming file paths
      const incomingFilePaths = new Set()
      for (const file of files || []) {
        const rawPath = file.name || file.path || ''
        if (!rawPath) continue
        const filePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
        incomingFilePaths.add(filePath)
      }

      // Process added or modified files (files with URL) — downloads first
      for (const file of files || []) {
        // ... existing download + upsert logic ...
      }

      // Fetch authoritative entity list from project document
      const existingPaths = []
      try {
        const entities =
          await ProjectEntityHandler.promises.getAllEntities(projectId)
        for (const { path: docPath } of entities.docs || []) {
          const fp = docPath.startsWith('/') ? docPath : `/${docPath}`
          existingPaths.push(fp)
        }
        for (const { path: filePath } of entities.files || []) {
          const fp = filePath.startsWith('/') ? filePath : `/${filePath}`
          existingPaths.push(fp)
        }
        for (const { path: folderPath } of entities.folders || []) {
          const fp = folderPath.startsWith('/') ? folderPath : `/${folderPath}`
          existingPaths.push(fp)
        }
      } catch (err) {
        logger.warn(
          { err, projectId },
          'could not fetch project entities for deletion comparison'
        )
      }

      // Delete files removed from git
      for (const existingPath of existingPaths) {
        // ... existing delete logic ...
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs \
      services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs
git commit -m "[git-bridge] download files before deleting removed entities in processPush

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Add folders to deletion comparison

**Files:**
- Modify: `services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs:349-356`

**Interfaces:**
- Consumes: `ProjectEntityHandler.promises.getAllEntities(projectId)` → `{ docs, files, folders }` where `folders` is `Array<{path: string}>`

- [ ] **Step 1: Write failing test for folder deletion**

Add to `GitBridgeSnapshotManager.test.mjs`:

```javascript
describe('processPush folder deletion', function () {
  it('includes folders in deletion comparison', async function () {
    const projectId = 'folder-del-test'
    const deletedPaths = []

    setMockProject(async () => ({
      _id: projectId,
      version: 1,
      rootFolder: [
        {
          _id: 'root',
          name: 'rootFolder',
          docs: [],
          fileRefs: [],
          folders: [
            { _id: 'f1', name: 'images', docs: [], fileRefs: [], folders: [] },
          ],
        },
      ],
    }))

    DocstoreManager.promises.getAllDocVersions = async () => []

    EditorController.promises.deleteEntityWithPath = async (
      projectId,
      path
    ) => {
      deletedPaths.push(path)
    }

    // No files in the push — the folder should be deleted
    const files = []

    await GitBridgeSnapshotManager.processPush(projectId, 'user-1', files, null)

    expect(deletedPaths).toContain('/images')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs`
Expected: FAIL — `/images` not in `deletedPaths` because folders aren't included

- [ ] **Step 3: Add folders to existingPaths**

In `GitBridgeSnapshotManager.mjs`, after the files loop in the entity-fetch block (around line 353-356), add:

```javascript
        for (const { path: folderPath } of entities.folders || []) {
          const fp = folderPath.startsWith('/') ? folderPath : `/${folderPath}`
          existingPaths.push(fp)
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs \
      services/web/test/unit/src/Features/GitBridge/GitBridgeSnapshotManager.test.mjs
git commit -m "[git-bridge] include folders in deletion comparison

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Fix Node version threshold in Dockerfile

**Files:**
- Modify: `server-ce/Dockerfile:12`

- [ ] **Step 1: Fix the Node version check from < 20 to < 22**

In `server-ce/Dockerfile`, change line 12:

```dockerfile
# Ensure Node >= 22 is installed (required by --experimental-transform-types)
RUN if ! /usr/bin/node -e "if (parseInt(process.versions.node) < 22) process.exit(1)" 2>/dev/null; then \
      curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz | tar -xJ --strip-components=1 -C /usr/local && \
      ln -sf /usr/local/bin/node /usr/bin/node && \
      ln -sf /usr/bin/npm && \
      ln -sf /usr/local/bin/npx /usr/bin/npx; \
    fi
```

- [ ] **Step 2: Commit**

```bash
git add server-ce/Dockerfile
git commit -m "[git-bridge] fix Node version threshold to >= 22 for --experimental-transform-types

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Fix case-insensitive GIT_BRIDGE_ENABLED in nginx init script

**Files:**
- Modify: `server-ce/init_scripts/200_nginx_config_template.sh:45`

- [ ] **Step 1: Fix the case-sensitive comparison**

In `server-ce/init_scripts/200_nginx_config_template.sh`, replace line 45:

```bash
  if [ "$(echo "${GIT_BRIDGE_ENABLED:-true}" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
```

- [ ] **Step 2: Commit**

```bash
git add server-ce/init_scripts/200_nginx_config_template.sh
git commit -m "[git-bridge] case-insensitive GIT_BRIDGE_ENABLED in nginx init script

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Handle /git (no trailing slash) in nginx config

**Files:**
- Modify: `server-ce/nginx/git-bridge.conf.template`

- [ ] **Step 1: Add redirect for /git to /git/**

In `server-ce/nginx/git-bridge.conf.template`, add before the `location /git/` block:

```nginx
# Redirect /git (no trailing slash) to /git/
location = /git {
  return 301 /git/;
}
```

- [ ] **Step 2: Commit**

```bash
git add server-ce/nginx/git-bridge.conf.template
git commit -m "[git-bridge] redirect /git to /git/ in nginx config

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Add try/catch to PersonalAccessTokenController

**Files:**
- Modify: `services/web/app/src/Features/GitBridge/PersonalAccessTokenController.mjs`

**Interfaces:**
- Produces: All controller methods wrapped in try/catch, returning 500 on internal errors

- [ ] **Step 1: Write failing test for error handling**

Add to `services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenController.test.mjs`:

```javascript
describe('PersonalAccessTokenController error handling', function () {
  it('returns 500 when createToken throws', async function () {
    const origCreateToken = PersonalAccessTokenManager.createToken
    PersonalAccessTokenManager.createToken = async () => {
      throw new Error('DB error')
    }

    const req = {
      session: { user: { _id: 'user-1' } },
      body: { name: 'test' },
    }
    const statusCalls = []
    const jsonCalls = []
    const res = {
      status(code) {
        statusCalls.push(code)
        return this
      },
      json(data) {
        jsonCalls.push(data)
        return this
      },
    }

    await PersonalAccessTokenController.createToken(req, res)
    expect(statusCalls[0]).toBe(500)
    expect(jsonCalls[0]).toEqual({ code: 'error', message: 'DB error' })

    PersonalAccessTokenManager.createToken = origCreateToken
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenController.test.mjs`
Expected: FAIL — unhandled rejection, no 500 response

- [ ] **Step 3: Add try/catch to all controller methods**

In `PersonalAccessTokenController.mjs`, wrap each method:

```javascript
import PersonalAccessTokenManager from './PersonalAccessTokenManager.mjs'
import SessionManager from '../Authentication/SessionManager.mjs'
import logger from '@overleaf/logger'

const PersonalAccessTokenController = {
  async createToken(req, res) {
    const userId =
      req.session?.user?._id || SessionManager.getLoggedInUserId(req.session)
    const { name } = req.body || {}
    try {
      const result = await PersonalAccessTokenManager.createToken(userId, name)
      return res.json({
        token: result.token,
        tokenPrefix: result.tokenPrefix,
        name: result.record.name,
        createdAt: result.record.createdAt,
      })
    } catch (err) {
      logger.error({ err, userId }, 'error creating personal access token')
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  async listTokens(req, res) {
    const userId =
      req.session?.user?._id || SessionManager.getLoggedInUserId(req.session)
    try {
      const tokens = await PersonalAccessTokenManager.listTokens(userId)
      return res.json(tokens)
    } catch (err) {
      logger.error({ err, userId }, 'error listing personal access tokens')
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },

  async revokeToken(req, res) {
    const userId =
      req.session?.user?._id || SessionManager.getLoggedInUserId(req.session)
    const { tokenId } = req.params
    try {
      await PersonalAccessTokenManager.revokeToken(userId, tokenId)
      return res.sendStatus(204)
    } catch (err) {
      logger.error({ err, userId, tokenId }, 'error revoking personal access token')
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },
}

export default PersonalAccessTokenController
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenController.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/web/app/src/Features/GitBridge/PersonalAccessTokenController.mjs \
      services/web/test/unit/src/Features/GitBridge/PersonalAccessTokenController.test.mjs
git commit -m "[git-bridge] add try/catch error handling to PersonalAccessTokenController

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: Remove stale proxy assertions from GitBridgeRouter test

**Files:**
- Modify: `services/web/test/unit/src/Features/GitBridge/GitBridgeRouter.test.mjs`

- [ ] **Step 1: Read the current test to find stale assertions**

Run: `grep -n "use.calledWith\|/git" services/web/test/unit/src/Features/GitBridge/GitBridgeRouter.test.mjs`

- [ ] **Step 2: Remove stale proxy assertions**

In `GitBridgeRouter.test.mjs`, remove any lines asserting:
```javascript
expect(webRouter.use.calledWith('/git')).toBe(true)
expect(publicApiRouter.use.calledWith('/git')).toBe(true)
```

Replace with assertions that match the current router structure — verify the snapshot routes are registered with auth middleware:

```javascript
// Verify snapshot routes are registered with auth + authorization middleware
expect(webRouter.get.calledWith('/api/v0/docs/:projectId')).toBe(true)
expect(webRouter.post.calledWith('/api/v0/docs/:projectId/snapshots')).toBe(true)
```

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test --import ./services/web/test/unit/test-register.mjs services/web/test/unit/src/Features/GitBridge/GitBridgeRouter.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add services/web/test/unit/src/Features/GitBridge/GitBridgeRouter.test.mjs
git commit -m "[git-bridge] remove stale proxy assertions from router test

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: Fix frontend test selectors for git-bridge-modal

**Files:**
- Modify: `services/web/test/frontend/features/ide-react/git-bridge-modal.test.tsx`

- [ ] **Step 1: Read the current test and component to identify mismatches**

Run: `cat services/web/test/frontend/features/ide-react/git-bridge-modal.test.tsx`
Run: `cat services/web/frontend/js/features/ide-react/components/modals/git-bridge-modal.tsx`

Identify:
- `getByRole('textbox', { name: 'Git clone project command' })` → component renders `<code>` not a textbox
- `getByRole('textbox', { name: 'Git authentication token' })` → same issue
- Copy text `'Copy this token now. It will not be shown again.'` → check actual rendered text

- [ ] **Step 2: Update test selectors to match component DOM**

Replace `getByRole('textbox', ...)` queries with text-based queries:
```typescript
// Replace textbox queries with text content queries
const cloneCommand = getByText(/git clone/)
expect(cloneCommand).toBeTruthy()
```

Update copy text to match the actual component output. Read the component's rendered text and update the test expectation accordingly.

- [ ] **Step 3: Run test to verify it passes**

Run frontend test suite (if available in environment).
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add services/web/test/frontend/features/ide-react/git-bridge-modal.test.tsx
git commit -m "[git-bridge] fix modal test selectors to match component DOM

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: Fix frontend test selectors for git-tokens-widget

**Files:**
- Modify: `services/web/test/frontend/features/settings/components/linking/git-tokens-widget.test.tsx`

- [ ] **Step 1: Read the current test and component to identify mismatches**

Run: `cat services/web/test/frontend/features/settings/components/linking/git-tokens-widget.test.tsx`
Run: `cat services/web/frontend/js/features/settings/components/linking/git-tokens-widget.tsx`

Identify:
- `getByRole('button', { name: 'Delete token' })` → should be `getByRole('button', { name: 'Remove' })`
- Text `'Never'` → should be `'N/A'`
- Token displayed in `<code>` not textbox

- [ ] **Step 2: Update test selectors to match component**

Replace:
```typescript
// Old: getByRole('button', { name: 'Delete token' })
// New: getByRole('button', { name: 'Remove' })

// Old: getByText('Never')
// New: getByText('N/A')
```

- [ ] **Step 3: Run test to verify it passes**

Run frontend test suite (if available in environment).
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add services/web/test/frontend/features/settings/components/linking/git-tokens-widget.test.tsx
git commit -m "[git-bridge] fix tokens-widget test selectors for aria-label and text changes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 14: Fix handleDelete to check res.ok in git-tokens-widget

**Files:**
- Modify: `services/web/frontend/js/features/settings/components/linking/git-tokens-widget.tsx:162-180`

- [ ] **Step 1: Fix handleDelete to check res.ok**

In `git-tokens-widget.tsx`, replace `handleDelete` (lines 162-180):

```typescript
  const handleDelete = async () => {
    if (!tokenToDelete) return
    try {
      const csrfToken =
        (typeof window !== 'undefined' && (window as any).csrfToken) ||
        getMeta('ol-csrfToken') ||
        ''
      const response = await fetch(`/user/personal-access-tokens/${tokenToDelete._id}`, {
        method: 'DELETE',
        headers: {
          'X-Csrf-Token': csrfToken,
        },
      })
      if (!response.ok) {
        console.error('Failed to delete token', response.status)
        return
      }
      setTokenToDelete(null)
      fetchTokens()
    } catch (err) {
      console.error('Failed to delete token', err)
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add services/web/frontend/js/features/settings/components/linking/git-tokens-widget.tsx
git commit -m "[git-bridge] check res.ok before closing delete modal

Co-Authored-By: Claude <noreply@anthropic.com>"
```
