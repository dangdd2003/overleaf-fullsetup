# Overleaf MCP — Web Auth & Endpoint Layer Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user-authorized `/api/v0/mcp/*` REST surface to the Overleaf `web` service, backed by the existing `personalAccessTokens` collection with enforced scopes, so an external MCP adapter can act strictly within a token owner's own project space.

**Architecture:** Extract the Personal Access Token (PAT) manager/controller out of `Features/GitBridge/` into a neutral `Features/PersonalAccessToken/` module and give tokens meaningful `scopes`. Add a new `Features/Mcp/` module whose single middleware chain — `requireMcpAuth` (token → userId + `mcp` scope) then `requireMcpProjectRead` / `requireMcpProjectWrite` (`AuthorizationManager`) — guards every route. Route handlers are thin and delegate to existing `web` managers. The feature is gated on `Settings.enableMcp` and is off by default.

**Tech Stack:** Node.js ESM (`.mjs`), Express routers, Mongoose (`personalAccessTokens`), Vitest for unit tests, Mocha + acceptance harness (`test/acceptance/bootstrap.js`) for acceptance tests. All commands run from `overleaf/services/web`.

**Spec:** `docs/superpowers/specs/2026-09-04-overleaf-mcp-per-user-auth-design.md`

**Plan 2 (separate document, written after this plan executes):** rebuild `overleaf/services/mcp/` on the official `@modelcontextprotocol/sdk`, wire tool handlers to these endpoints, add `server-ce` runit + nginx + compose, run the two-user isolation acceptance gate end to end.

## Global Constraints

- Feature disabled by default: `Settings.enableMcp` defaults to `false`; every new route and the PAT-route decoupling must no-op when it is false. Pure CE behavior is unchanged.
- Token format: `olp_` + 32 lowercase hex chars. Stored as SHA-256 hex in `tokenHash` (unique index). Never log or return the raw token except once at creation.
- Bearer token is read from the `Authorization` header **only** — no query-string or request-body fallback anywhere.
- Allowed token scopes: exactly `git_bridge` and `mcp`. `createToken` defaults to `['git_bridge']` when `scopes` is omitted (backward compatible).
- Error envelope for all `/api/v0/mcp/*` responses: JSON `{ code, message }` with codes and HTTP statuses exactly as in spec §9: `unauthorized`/401, `insufficient_scope`/403, `forbidden`/403, `not_found`/404, `validation_error`/400, `rate_limited`/429, `upstream_error`/502.
- `not_found` (404) is returned for BOTH a missing project and a project the user may not access — no existence oracle. `forbidden` (403) is only for a user who can see a project but lacks the privilege level a route needs (e.g. read-only collaborator on a write route).
- Never route MCP requests through `privateApiRouter` or the internal shared secret.
- Git-bridge behavior must remain unchanged: its existing unit tests stay green after the PAT extraction.
- Follow existing `web` conventions: `.mjs` ESM, `Manager`/`Controller`/`Handler` naming, `promises` + `callbackify` dual API on managers, `expressify`/`expressifyAsync` for async route handlers (check a neighboring controller for the exact helper name in this tree).
- Commit after every task with a message in the repo's short conventional style (e.g. `feat(mcp): ...`, `refactor(pat): ...`). Do not `git push`. Verify each commit is signed (`git log --show-signature -1`).

---

## File Structure

**Moved (Task 1):**
- `app/src/Features/GitBridge/PersonalAccessTokenManager.mjs` → `app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs`
- `app/src/Features/GitBridge/PersonalAccessTokenController.mjs` → `app/src/Features/PersonalAccessToken/PersonalAccessTokenController.mjs`
- test files move to `test/unit/src/Features/PersonalAccessToken/`

**Created:**
- `app/src/Features/PersonalAccessToken/PersonalAccessTokenRouter.mjs` — mounts `/user/personal-access-tokens` when `enableGitBridge || enableMcp`
- `app/src/Features/Mcp/McpAuthMiddleware.mjs` — `requireMcpAuth`
- `app/src/Features/Mcp/McpAuthorizationMiddleware.mjs` — `requireMcpProjectRead`, `requireMcpProjectWrite`
- `app/src/Features/Mcp/McpErrors.mjs` — error envelope helper + code constants
- `app/src/Features/Mcp/McpProjectsController.mjs` — projects + settings endpoints
- `app/src/Features/Mcp/McpFilesController.mjs` — tree, doc read/write, folder, move, file upload
- `app/src/Features/Mcp/McpCompileController.mjs` — compile, log, pdf, clear-cache, wordcount, synctex
- `app/src/Features/Mcp/McpUrlFetcher.mjs` — SSRF-guarded fetch for `url` uploads
- `app/src/Features/Mcp/McpRouter.mjs` — route table, `apply(webRouter)`, no-op when `!enableMcp`
- test files under `test/unit/src/Features/Mcp/` and `test/acceptance/src/McpTests.mjs`

**Modified:**
- `app/src/Features/GitBridge/GitBridgeRouter.mjs` — import PAT from new path; drop its own PAT route registration (moved to `PersonalAccessTokenRouter`)
- `app/src/router.mjs` — import + apply `PersonalAccessTokenRouter` and `McpRouter`
- `config/settings.defaults.js` — add `enableMcp` + `mcp` config block
- `config/settings.overrides.*` / server-ce settings as needed for the env var (confirm file in tree)

---

## Task 1: Extract PAT module out of GitBridge (no behavior change)

**Files:**
- Create: `app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs` (moved)
- Create: `app/src/Features/PersonalAccessToken/PersonalAccessTokenController.mjs` (moved)
- Create: `app/src/Features/PersonalAccessToken/PersonalAccessTokenRouter.mjs`
- Modify: `app/src/Features/GitBridge/GitBridgeRouter.mjs`
- Modify: `app/src/router.mjs`
- Move test: `test/unit/src/Features/GitBridge/PersonalAccessTokenManager.test.mjs` → `test/unit/src/Features/PersonalAccessToken/PersonalAccessTokenManager.test.mjs`
- Move test: `test/unit/src/Features/GitBridge/PersonalAccessTokenController.test.mjs` → `test/unit/src/Features/PersonalAccessToken/PersonalAccessTokenController.test.mjs`

**Interfaces:**
- Produces: `PersonalAccessTokenManager` default export with `{ createToken, validateToken, listTokens, revokeToken }` and `.promises` alias, unchanged signatures except `validateToken` return type changes in Task 2.
- Produces: `PersonalAccessTokenRouter.apply(webRouter)` — registers `POST/GET/DELETE /user/personal-access-tokens` when `Settings.enableGitBridge || Settings.enableMcp`, each behind `AuthenticationController.requireLogin()`.

- [ ] **Step 1: Move the two source files unchanged**

```bash
cd overleaf/services/web
mkdir -p app/src/Features/PersonalAccessToken
git mv app/src/Features/GitBridge/PersonalAccessTokenManager.mjs app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs
git mv app/src/Features/GitBridge/PersonalAccessTokenController.mjs app/src/Features/PersonalAccessToken/PersonalAccessTokenController.mjs
mkdir -p test/unit/src/Features/PersonalAccessToken
git mv test/unit/src/Features/GitBridge/PersonalAccessTokenManager.test.mjs test/unit/src/Features/PersonalAccessToken/PersonalAccessTokenManager.test.mjs
git mv test/unit/src/Features/GitBridge/PersonalAccessTokenController.test.mjs test/unit/src/Features/PersonalAccessToken/PersonalAccessTokenController.test.mjs
```

- [ ] **Step 2: Fix import paths in the moved files and their tests**

In both moved test files, the relative depth is unchanged (`GitBridge` and `PersonalAccessToken` are both one level under `Features`), so `../../../../../app/src/...` prefixes stay valid, but update the final path segment:
`app/src/Features/GitBridge/PersonalAccessTokenManager.mjs` → `app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs` in the `import` lines.
In `PersonalAccessTokenController.mjs`, update its `import PersonalAccessTokenManager from './PersonalAccessTokenManager.mjs'` — unchanged (same folder). Update any `import` of sibling GitBridge files to the `../GitBridge/` prefix.

- [ ] **Step 3: Create `PersonalAccessTokenRouter.mjs`**

```javascript
import Settings from '@overleaf/settings'
import AuthenticationController from '../Authentication/AuthenticationController.mjs'
import PersonalAccessTokenController from './PersonalAccessTokenController.mjs'

const PersonalAccessTokenRouter = {
  apply(webRouter) {
    if (!(Settings.enableGitBridge || Settings.enableMcp)) {
      return
    }
    webRouter.post(
      '/user/personal-access-tokens',
      AuthenticationController.requireLogin(),
      PersonalAccessTokenController.createToken
    )
    webRouter.get(
      '/user/personal-access-tokens',
      AuthenticationController.requireLogin(),
      PersonalAccessTokenController.listTokens
    )
    webRouter.delete(
      '/user/personal-access-tokens/:tokenId',
      AuthenticationController.requireLogin(),
      PersonalAccessTokenController.revokeToken
    )
  },
}

export default PersonalAccessTokenRouter
export { PersonalAccessTokenRouter }
```

- [ ] **Step 4: Remove the PAT routes from `GitBridgeRouter.mjs`**

Delete the three `/user/personal-access-tokens` route registrations (the block commented "1. User Personal Access Token (PAT) Management"). Change its import from `./PersonalAccessTokenController.mjs` to `../PersonalAccessToken/PersonalAccessTokenManager.mjs` where the manager is used (`resolveAuthUser` in `GitBridgeApiController.mjs` — update that import too: `./PersonalAccessTokenManager.mjs` → `../PersonalAccessToken/PersonalAccessTokenManager.mjs`).

- [ ] **Step 5: Wire both routers in `router.mjs`**

Near the existing `import GitBridgeRouter from './Features/GitBridge/GitBridgeRouter.mjs'`:

```javascript
import PersonalAccessTokenRouter from './Features/PersonalAccessToken/PersonalAccessTokenRouter.mjs'
import McpRouter from './Features/Mcp/McpRouter.mjs'
```

Near the existing `GitBridgeRouter.apply(webRouter, privateApiRouter, publicApiRouter)`:

```javascript
PersonalAccessTokenRouter.apply(webRouter)
McpRouter.apply(webRouter)
```

(`McpRouter` is created in Task 4; add a minimal stub now — `export default { apply() {} }` — so `router.mjs` imports cleanly, then flesh it out in Task 4. Note the stub in the commit message.)

- [ ] **Step 6: Run the moved + git-bridge unit tests**

Run: `npx vitest run test/unit/src/Features/PersonalAccessToken test/unit/src/Features/GitBridge`
Expected: PASS (same assertions as before the move).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(pat): extract personal access tokens out of git-bridge module"
```

---

## Task 2: Token scopes — data + validation

**Files:**
- Modify: `app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs`
- Modify: `app/src/models/PersonalAccessToken.mjs` (only if a scope enum is added — optional; keep `[String]`)
- Test: `test/unit/src/Features/PersonalAccessToken/PersonalAccessTokenManager.test.mjs`

**Interfaces:**
- Produces: `createToken(userId, name, scopes)` — `scopes?: string[]`, defaults to `['git_bridge']`; throws `ValidationError` if any scope is not in `['git_bridge', 'mcp']`.
- Produces: `validateToken(raw)` → `{ userId: string, email: string, scopes: string[] } | null` (was `{ user_id, email, scope: string }`). **Breaking:** update `GitBridgeApiController.resolveAuthUser` to read `tokenInfo.userId`.

- [ ] **Step 1: Write failing tests**

Add to `PersonalAccessTokenManager.test.mjs`:

```javascript
it('defaults scopes to [git_bridge] when omitted', async () => {
  const { record } = await createToken(userId, 'My Token')
  expect(record.scopes).toEqual(['git_bridge'])
})

it('persists the requested scopes', async () => {
  const { record } = await createToken(userId, 'AI', ['mcp'])
  expect(record.scopes).toEqual(['mcp'])
})

it('rejects unknown scopes', async () => {
  await expect(createToken(userId, 'bad', ['root'])).rejects.toThrow(/scope/i)
})

it('validateToken returns userId, email and scopes array', async () => {
  const token = 'olp_' + '0'.repeat(32)
  mockFindRecord = {
    user_id: userId,
    scopes: ['mcp', 'git_bridge'],
    expiresAt: new Date(Date.now() + 1000),
    save: async () => {},
  }
  const info = await validateToken(token)
  expect(info).toEqual({
    userId,
    email: userEmail,
    scopes: ['mcp', 'git_bridge'],
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/src/Features/PersonalAccessToken/PersonalAccessTokenManager.test.mjs`
Expected: FAIL — new assertions fail (`scope` vs `scopes`, no validation).

- [ ] **Step 3: Implement**

In `PersonalAccessTokenManager.mjs`:

```javascript
import OError from '@overleaf/o-error'

const ALLOWED_SCOPES = ['git_bridge', 'mcp']

async function createToken(userId, name, scopes) {
  const finalScopes =
    Array.isArray(scopes) && scopes.length ? scopes : ['git_bridge']
  for (const s of finalScopes) {
    if (!ALLOWED_SCOPES.includes(s)) {
      throw new OError('invalid personal access token scope', { scope: s })
    }
  }
  // ... existing hash/prefix/expiry code ...
  const record = await PersonalAccessToken.create({
    user_id: userId,
    name: name || 'Git Token',
    tokenHash,
    tokenPrefix,
    scopes: finalScopes,
    createdAt: now,
    expiresAt,
  })
  return { token, tokenPrefix, record }
}
```

In `validateToken`, replace the return block:

```javascript
  const scopes = Array.isArray(record.scopes)
    ? record.scopes
    : record.scopes
      ? [record.scopes]
      : ['git_bridge']
  return {
    userId: record.user_id ? record.user_id.toString() : null,
    email: user.email,
    scopes,
  }
```

Export `ALLOWED_SCOPES`.

- [ ] **Step 4: Update the git-bridge consumer**

In `app/src/Features/GitBridge/GitBridgeApiController.mjs`, `resolveAuthUser`: change `tokenInfo?.user_id` → `tokenInfo?.userId` and `return tokenInfo.user_id` → `return tokenInfo.userId`.

- [ ] **Step 5: Run PAT + git-bridge unit tests**

Run: `npx vitest run test/unit/src/Features/PersonalAccessToken test/unit/src/Features/GitBridge`
Expected: PASS. If a GitBridge test asserted the old `user_id`/`scope` shape, update it to the new shape (behavior identical).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(pat): add enforced token scopes (git_bridge, mcp)"
```

---

## Task 3: `enableMcp` setting + `mcp` config block

**Files:**
- Modify: `config/settings.defaults.js`
- Test: `test/unit/src/Features/Mcp/McpSettings.test.mjs` (new)

**Interfaces:**
- Produces: `Settings.enableMcp: boolean` (default `false`, from `process.env.OVERLEAF_MCP_ENABLED === 'true'`).
- Produces: `Settings.mcp: { maxUploadBytes: number, allowedUploadExtensions: string[] }`.

- [ ] **Step 1: Write failing test**

`test/unit/src/Features/Mcp/McpSettings.test.mjs`:

```javascript
import { describe, it, expect } from 'vitest'
import Settings from '@overleaf/settings'

describe('MCP settings', () => {
  it('enableMcp defaults to false', () => {
    expect(Settings.enableMcp).toBe(false)
  })
  it('exposes an mcp upload config block', () => {
    expect(Settings.mcp.maxUploadBytes).toBeGreaterThan(0)
    expect(Settings.mcp.allowedUploadExtensions).toContain('png')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/src/Features/Mcp/McpSettings.test.mjs`
Expected: FAIL — `Settings.enableMcp` undefined.

- [ ] **Step 3: Implement in `config/settings.defaults.js`**

Add near the `enableGitBridge`-adjacent settings (search the file for where feature toggles live; if `enableGitBridge` is only set in `GitBridgeRouter`, add both here for clarity):

```javascript
  enableMcp: process.env.OVERLEAF_MCP_ENABLED === 'true',

  mcp: {
    maxUploadBytes: parseInt(process.env.MCP_MAX_UPLOAD_MB || '20', 10) * 1024 * 1024,
    allowedUploadExtensions: [
      'png', 'jpg', 'jpeg', 'pdf', 'eps', 'svg', 'gif', 'csv', 'bib', 'txt',
    ],
  },
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/unit/src/Features/Mcp/McpSettings.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mcp): add enableMcp toggle and upload config (default off)"
```

---

## Task 4: `McpErrors` + `McpRouter` skeleton

**Files:**
- Create: `app/src/Features/Mcp/McpErrors.mjs`
- Create: `app/src/Features/Mcp/McpRouter.mjs` (replaces the Task 1 stub)
- Test: `test/unit/src/Features/Mcp/McpErrors.test.mjs`
- Test: `test/unit/src/Features/Mcp/McpRouter.test.mjs`

**Interfaces:**
- Produces: `McpErrors.CODES` — `{ UNAUTHORIZED, INSUFFICIENT_SCOPE, FORBIDDEN, NOT_FOUND, VALIDATION, RATE_LIMITED, UPSTREAM }` string constants.
- Produces: `McpErrors.send(res, code, message?)` — sets the correct HTTP status and writes `{ code, message }`.
- Produces: `McpErrors.STATUS` — map from code → HTTP status.
- Produces: `McpRouter.apply(webRouter)` — no-op when `!Settings.enableMcp`; otherwise mounts all Task 5–8 routes.

- [ ] **Step 1: Write failing tests**

`test/unit/src/Features/Mcp/McpErrors.test.mjs`:

```javascript
import { describe, it, expect, vi } from 'vitest'
import McpErrors from '../../../../../app/src/Features/Mcp/McpErrors.mjs'

function fakeRes() {
  return { statusCode: 0, body: null, status(s) { this.statusCode = s; return this }, json(b) { this.body = b; return this } }
}

describe('McpErrors', () => {
  it('maps not_found to 404', () => {
    const res = fakeRes()
    McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('not_found')
  })
  it('maps insufficient_scope to 403 with a default message', () => {
    const res = fakeRes()
    McpErrors.send(res, McpErrors.CODES.INSUFFICIENT_SCOPE)
    expect(res.statusCode).toBe(403)
    expect(res.body.message).toMatch(/scope/i)
  })
})
```

`test/unit/src/Features/Mcp/McpRouter.test.mjs`:

```javascript
import { describe, it, expect, vi } from 'vitest'

describe('McpRouter', () => {
  it('registers no routes when enableMcp is false', async () => {
    vi.doMock('@overleaf/settings', () => ({ default: { enableMcp: false } }))
    const { default: McpRouter } = await import(
      '../../../../../app/src/Features/Mcp/McpRouter.mjs'
    )
    const webRouter = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    McpRouter.apply(webRouter)
    expect(webRouter.get).not.toHaveBeenCalled()
    expect(webRouter.post).not.toHaveBeenCalled()
    vi.doUnmock('@overleaf/settings')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/src/Features/Mcp/McpErrors.test.mjs test/unit/src/Features/Mcp/McpRouter.test.mjs`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement `McpErrors.mjs`**

```javascript
const CODES = {
  UNAUTHORIZED: 'unauthorized',
  INSUFFICIENT_SCOPE: 'insufficient_scope',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VALIDATION: 'validation_error',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM: 'upstream_error',
}

const STATUS = {
  [CODES.UNAUTHORIZED]: 401,
  [CODES.INSUFFICIENT_SCOPE]: 403,
  [CODES.FORBIDDEN]: 403,
  [CODES.NOT_FOUND]: 404,
  [CODES.VALIDATION]: 400,
  [CODES.RATE_LIMITED]: 429,
  [CODES.UPSTREAM]: 502,
}

const DEFAULT_MESSAGE = {
  [CODES.UNAUTHORIZED]: 'valid authentication required',
  [CODES.INSUFFICIENT_SCOPE]: 'token is missing the required mcp scope',
  [CODES.FORBIDDEN]: 'insufficient project privileges',
  [CODES.NOT_FOUND]: 'not found',
  [CODES.VALIDATION]: 'invalid request',
  [CODES.RATE_LIMITED]: 'rate limit exceeded',
  [CODES.UPSTREAM]: 'an upstream service failed',
}

function send(res, code, message) {
  return res
    .status(STATUS[code] || 500)
    .json({ code, message: message || DEFAULT_MESSAGE[code] || 'error' })
}

export default { CODES, STATUS, send }
export { CODES, STATUS, send }
```

- [ ] **Step 4: Implement `McpRouter.mjs` (routes added in later tasks; guard now)**

```javascript
import Settings from '@overleaf/settings'
import { requireMcpAuth } from './McpAuthMiddleware.mjs'
import {
  requireMcpProjectRead,
  requireMcpProjectWrite,
} from './McpAuthorizationMiddleware.mjs'
import McpProjectsController from './McpProjectsController.mjs'
import McpFilesController from './McpFilesController.mjs'
import McpCompileController from './McpCompileController.mjs'

const McpRouter = {
  apply(webRouter) {
    if (!Settings.enableMcp) {
      return
    }
    // Routes are registered by Tasks 5-8. Until then this block is empty.
  },
}

export default McpRouter
export { McpRouter }
```

Note: the imports of controllers created in later tasks will fail until those tasks land. To keep the tree importable between tasks, add the controller/middleware modules as minimal stubs now (`export default {}` / `export function requireMcpAuth() {}`) and replace them in their tasks. State this in the commit message.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/unit/src/Features/Mcp`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(mcp): add error envelope and router skeleton (stubs for controllers)"
```

---

## Task 5: `requireMcpAuth` middleware

**Files:**
- Create: `app/src/Features/Mcp/McpAuthMiddleware.mjs` (replaces stub)
- Test: `test/unit/src/Features/Mcp/McpAuthMiddleware.test.mjs`

**Interfaces:**
- Consumes: `PersonalAccessTokenManager.validateToken` → `{ userId, email, scopes } | null`; `McpErrors`.
- Produces: `requireMcpAuth(req, res, next)` — on success sets `req.mcpUserId: string`, `req.mcpTokenPrefix: string`, `req.mcpScopes: string[]`, calls `next()`. On failure sends the error envelope and does NOT call `next()`.
- Produces: `LAST_USED_THROTTLE_MS = 60000` (exported for the manager's throttle logic — actually the throttle lives in `validateToken`; see Step 3).

- [ ] **Step 1: Write failing tests**

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const validateToken = vi.fn()
vi.mock(
  '../../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs',
  () => ({ default: { validateToken }, validateToken })
)
const { requireMcpAuth } = await import(
  '../../../../../app/src/Features/Mcp/McpAuthMiddleware.mjs'
)

function ctx(headers = {}) {
  const req = { headers, get: name => headers[name.toLowerCase()] }
  const res = {
    statusCode: 0, body: null,
    status(s) { this.statusCode = s; return this },
    json(b) { this.body = b; return this },
  }
  const next = vi.fn()
  return { req, res, next }
}

beforeEach(() => { validateToken.mockReset() })

describe('requireMcpAuth', () => {
  it('401 when no Authorization header', async () => {
    const { req, res, next } = ctx()
    await requireMcpAuth(req, res, next)
    expect(res.statusCode).toBe(401)
    expect(res.body.code).toBe('unauthorized')
    expect(next).not.toHaveBeenCalled()
  })

  it('401 when token is invalid', async () => {
    validateToken.mockResolvedValue(null)
    const { req, res, next } = ctx({ authorization: 'Bearer olp_bad' })
    await requireMcpAuth(req, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('403 insufficient_scope when token lacks mcp scope', async () => {
    validateToken.mockResolvedValue({ userId: 'u1', email: 'e', scopes: ['git_bridge'] })
    const { req, res, next } = ctx({ authorization: 'Bearer olp_x' })
    await requireMcpAuth(req, res, next)
    expect(res.statusCode).toBe(403)
    expect(res.body.code).toBe('insufficient_scope')
    expect(next).not.toHaveBeenCalled()
  })

  it('passes and sets req.mcpUserId when token has mcp scope', async () => {
    validateToken.mockResolvedValue({ userId: 'u1', email: 'e', scopes: ['mcp'] })
    const { req, res, next } = ctx({ authorization: 'Bearer olp_good' })
    await requireMcpAuth(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(req.mcpUserId).toBe('u1')
    expect(req.mcpScopes).toEqual(['mcp'])
  })

  it('ignores query-string and body tokens', async () => {
    const { req, res, next } = ctx()
    req.query = { token: 'olp_x' }
    req.body = { token: 'olp_y' }
    await requireMcpAuth(req, res, next)
    expect(res.statusCode).toBe(401)
    expect(validateToken).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/src/Features/Mcp/McpAuthMiddleware.test.mjs`
Expected: FAIL — stub does nothing.

- [ ] **Step 3: Implement**

```javascript
import logger from '@overleaf/logger'
import PersonalAccessTokenManager from '../PersonalAccessToken/PersonalAccessTokenManager.mjs'
import McpErrors from './McpErrors.mjs'

function extractBearer(req) {
  const header = req.headers?.authorization || ''
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  return token || null
}

async function requireMcpAuth(req, res, next) {
  const token = extractBearer(req)
  if (!token) {
    return McpErrors.send(res, McpErrors.CODES.UNAUTHORIZED)
  }
  let info
  try {
    info = await PersonalAccessTokenManager.validateToken(token)
  } catch (err) {
    logger.warn({ err }, 'mcp token validation error')
    return McpErrors.send(res, McpErrors.CODES.UNAUTHORIZED)
  }
  if (!info || !info.userId) {
    return McpErrors.send(res, McpErrors.CODES.UNAUTHORIZED)
  }
  if (!info.scopes.includes('mcp')) {
    return McpErrors.send(res, McpErrors.CODES.INSUFFICIENT_SCOPE)
  }
  req.mcpUserId = info.userId
  req.mcpScopes = info.scopes
  req.mcpTokenPrefix = token.slice(0, 8)
  logger.info(
    { mcpUserId: req.mcpUserId, mcpTokenPrefix: req.mcpTokenPrefix, route: req.path },
    'mcp request authenticated'
  )
  return next()
}

export default { requireMcpAuth }
export { requireMcpAuth }
```

- [ ] **Step 4: Add the `lastUsedAt` throttle in `validateToken`**

In `PersonalAccessTokenManager.mjs`, wrap the `lastUsedAt` write:

```javascript
const LAST_USED_THROTTLE_MS = 60 * 1000
// ...
const stale =
  !record.lastUsedAt ||
  Date.now() - new Date(record.lastUsedAt).getTime() > LAST_USED_THROTTLE_MS
if (stale) {
  const now = new Date()
  record.lastUsedAt = now
  if (typeof record.save === 'function') {
    await record.save()
  } else {
    await PersonalAccessToken.updateOne(
      { _id: record._id },
      { $set: { lastUsedAt: now } }
    )
  }
}
```

Update the existing `PersonalAccessTokenManager.test.mjs` `lastUsedAt` test to set `mockFindRecord.lastUsedAt` to an old date so the write still fires.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/unit/src/Features/Mcp/McpAuthMiddleware.test.mjs test/unit/src/Features/PersonalAccessToken`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(mcp): add requireMcpAuth middleware with scope enforcement"
```

---

## Task 6: `requireMcpProjectRead` / `requireMcpProjectWrite`

**Files:**
- Create: `app/src/Features/Mcp/McpAuthorizationMiddleware.mjs` (replaces stub)
- Test: `test/unit/src/Features/Mcp/McpAuthorizationMiddleware.test.mjs`

**Interfaces:**
- Consumes: `AuthorizationManager.promises.canUserReadProject(userId, projectId, null)`, `canUserWriteProjectContent(userId, projectId, null)`; `req.mcpUserId` (set by `requireMcpAuth`); `McpErrors`; `Errors` (`web/app/src/Features/Errors/Errors.js`).
- Produces: `requireMcpProjectRead(req, res, next)`, `requireMcpProjectWrite(req, res, next)` — read `req.params.projectId`; on allow call `next()`; on deny for read → `not_found` (404); on deny for write → `forbidden` (403) if the user can read the project else `not_found` (404); on missing/invalid project id → `not_found` (404).

- [ ] **Step 1: Write failing tests**

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const canUserReadProject = vi.fn()
const canUserWriteProjectContent = vi.fn()
vi.mock('../../../../../app/src/Features/Authorization/AuthorizationManager.mjs', () => ({
  default: { promises: { canUserReadProject, canUserWriteProjectContent } },
}))
const { requireMcpProjectRead, requireMcpProjectWrite } = await import(
  '../../../../../app/src/Features/Mcp/McpAuthorizationMiddleware.mjs'
)

function ctx(projectId = '507f1f77bcf86cd799439011') {
  const req = { mcpUserId: 'u1', params: { projectId } }
  const res = {
    statusCode: 0, body: null,
    status(s) { this.statusCode = s; return this },
    json(b) { this.body = b; return this },
  }
  return { req, res, next: vi.fn() }
}

beforeEach(() => {
  canUserReadProject.mockReset()
  canUserWriteProjectContent.mockReset()
})

describe('requireMcpProjectRead', () => {
  it('calls next when the user can read', async () => {
    canUserReadProject.mockResolvedValue(true)
    const { req, res, next } = ctx()
    await requireMcpProjectRead(req, res, next)
    expect(next).toHaveBeenCalled()
  })
  it('returns 404 not_found (not 403) when the user cannot read', async () => {
    canUserReadProject.mockResolvedValue(false)
    const { req, res, next } = ctx()
    await requireMcpProjectRead(req, res, next)
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('not_found')
    expect(next).not.toHaveBeenCalled()
  })
  it('returns 404 for a malformed project id', async () => {
    const { req, res, next } = ctx('not-an-id')
    canUserReadProject.mockRejectedValue(Object.assign(new Error('cast'), { name: 'CastError' }))
    await requireMcpProjectRead(req, res, next)
    expect(res.statusCode).toBe(404)
  })
})

describe('requireMcpProjectWrite', () => {
  it('calls next when the user can write', async () => {
    canUserWriteProjectContent.mockResolvedValue(true)
    const { req, res, next } = ctx()
    await requireMcpProjectWrite(req, res, next)
    expect(next).toHaveBeenCalled()
  })
  it('returns 403 forbidden when the user can read but not write', async () => {
    canUserWriteProjectContent.mockResolvedValue(false)
    canUserReadProject.mockResolvedValue(true)
    const { req, res, next } = ctx()
    await requireMcpProjectWrite(req, res, next)
    expect(res.statusCode).toBe(403)
    expect(res.body.code).toBe('forbidden')
  })
  it('returns 404 not_found when the user cannot even read', async () => {
    canUserWriteProjectContent.mockResolvedValue(false)
    canUserReadProject.mockResolvedValue(false)
    const { req, res, next } = ctx()
    await requireMcpProjectWrite(req, res, next)
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('not_found')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/src/Features/Mcp/McpAuthorizationMiddleware.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

```javascript
import logger from '@overleaf/logger'
import AuthorizationManager from '../Authorization/AuthorizationManager.mjs'
import McpErrors from './McpErrors.mjs'

function isBadIdError(err) {
  return err && (err.name === 'CastError' || err.name === 'BSONError')
}

async function requireMcpProjectRead(req, res, next) {
  const { projectId } = req.params
  try {
    const canRead = await AuthorizationManager.promises.canUserReadProject(
      req.mcpUserId,
      projectId,
      null
    )
    if (!canRead) {
      return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
    }
    return next()
  } catch (err) {
    if (isBadIdError(err)) {
      return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
    }
    logger.error({ err, projectId, mcpUserId: req.mcpUserId }, 'mcp read authz error')
    return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
  }
}

async function requireMcpProjectWrite(req, res, next) {
  const { projectId } = req.params
  try {
    const canWrite =
      await AuthorizationManager.promises.canUserWriteProjectContent(
        req.mcpUserId,
        projectId,
        null
      )
    if (canWrite) {
      return next()
    }
    const canRead = await AuthorizationManager.promises.canUserReadProject(
      req.mcpUserId,
      projectId,
      null
    )
    return McpErrors.send(
      res,
      canRead ? McpErrors.CODES.FORBIDDEN : McpErrors.CODES.NOT_FOUND
    )
  } catch (err) {
    if (isBadIdError(err)) {
      return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
    }
    logger.error({ err, projectId, mcpUserId: req.mcpUserId }, 'mcp write authz error')
    return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
  }
}

export default { requireMcpProjectRead, requireMcpProjectWrite }
export { requireMcpProjectRead, requireMcpProjectWrite }
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/unit/src/Features/Mcp/McpAuthorizationMiddleware.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mcp): add per-project read/write authorization middleware"
```

---

## Task 7: Projects & files endpoints

**Files:**
- Create: `app/src/Features/Mcp/McpProjectsController.mjs`
- Create: `app/src/Features/Mcp/McpFilesController.mjs`
- Modify: `app/src/Features/Mcp/McpRouter.mjs`
- Test: `test/unit/src/Features/Mcp/McpProjectsController.test.mjs`
- Test: `test/unit/src/Features/Mcp/McpFilesController.test.mjs`

**Interfaces:**
- Consumes: `ProjectGetter.promises.findAllUsersProjects` / `getProject`, `ProjectCreationHandler.promises.createBlankProject` (+ `ProjectEntityUpdateHandler` for initial files), `ProjectEntityHandler.promises.getAllEntitiesFromProject` (or `getAllDocs`/`getAllFiles`), `DocstoreManager.promises.getDoc`, `DocumentUpdaterHandler.promises.setDocument`, `ProjectEntityUpdateHandler.promises.mkdirp` / `addDoc` / `moveEntity`, `EditorController` for settings. Confirm exact manager method names in this tree before writing (search `app/src/Features/Project/ProjectEntityUpdateHandler.mjs`).
- Produces: route handlers `listProjects`, `createProject`, `getProject`, `updateSettings`, `getTree`, `getDoc`, `writeDoc`, `createFolder`, `moveEntity` — all `(req, res)` async, using `req.mcpUserId` / `req.params.projectId`, replying with either a JSON payload or `McpErrors.send`.

- [ ] **Step 1: Write failing tests (representative — cover every handler)**

`test/unit/src/Features/Mcp/McpProjectsController.test.mjs`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ProjectGetter = { promises: { findAllUsersProjects: vi.fn(), getProject: vi.fn() } }
vi.mock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({ default: ProjectGetter }))
// ...mock ProjectCreationHandler, EditorController similarly...

const { default: McpProjectsController } = await import(
  '../../../../../app/src/Features/Mcp/McpProjectsController.mjs'
)

function res() {
  return {
    statusCode: 200, body: null,
    status(s) { this.statusCode = s; return this },
    json(b) { this.body = b; return this },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('McpProjectsController.listProjects', () => {
  it('returns only the calling user\'s projects in a compact shape', async () => {
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      owned: [{ _id: 'p1', name: 'Thesis' }],
      readAndWrite: [{ _id: 'p2', name: 'Shared' }],
      readOnly: [], tokenReadAndWrite: [], tokenReadOnly: [],
    })
    const req = { mcpUserId: 'u1', query: {} }
    const r = res()
    await McpProjectsController.listProjects(req, r)
    expect(r.body.projects.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(r.body.projects[0]).toHaveProperty('name', 'Thesis')
  })
})
```

`test/unit/src/Features/Mcp/McpFilesController.test.mjs`:

```javascript
describe('McpFilesController.getDoc', () => {
  it('applies a 1-indexed inclusive line range', async () => {
    DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['a', 'b', 'c', 'd'] })
    ProjectEntityHandler.promises.getAllEntitiesFromProject.mockResolvedValue({
      docs: [{ path: '/main.tex', doc: { _id: 'd1' } }], files: [],
    })
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { path: 'main.tex', startLine: '2', endLine: '3' } }
    const r = res()
    await McpFilesController.getDoc(req, r)
    expect(r.body.content).toBe('b\nc')
  })

  it('returns not_found for an unknown path', async () => {
    ProjectEntityHandler.promises.getAllEntitiesFromProject.mockResolvedValue({ docs: [], files: [] })
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, query: { path: 'nope.tex' } }
    const r = res()
    await McpFilesController.getDoc(req, r)
    expect(r.statusCode).toBe(404)
  })
})

describe('McpFilesController.writeDoc', () => {
  it('creates the doc when the path is new then setDocument via document-updater', async () => {
    ProjectEntityHandler.promises.getAllEntitiesFromProject.mockResolvedValue({ docs: [], files: [] })
    ProjectEntityUpdateHandler.promises.addDoc.mockResolvedValue({ doc: { _id: 'dNew' } })
    const req = {
      mcpUserId: 'u1', params: { projectId: 'p1' },
      body: { path: 'chapters/intro.tex', content: 'hello\nworld' },
    }
    const r = res()
    await McpFilesController.writeDoc(req, r)
    expect(ProjectEntityUpdateHandler.promises.addDoc).toHaveBeenCalled()
    expect(DocumentUpdaterHandler.promises.setDocument).toHaveBeenCalledWith(
      'p1', 'dNew', 'u1', ['hello', 'world'], 'mcp'
    )
    expect(r.body.status).toBe('ok')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/src/Features/Mcp/McpProjectsController.test.mjs test/unit/src/Features/Mcp/McpFilesController.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `McpProjectsController.mjs`**

```javascript
import ProjectGetter from '../Project/ProjectGetter.mjs'
import ProjectCreationHandler from '../Project/ProjectCreationHandler.mjs'
import ProjectEntityUpdateHandler from '../Project/ProjectEntityUpdateHandler.mjs'
import EditorController from '../Editor/EditorController.mjs'
import ProjectRootDocManager from '../Project/ProjectRootDocManager.mjs'
import McpErrors from './McpErrors.mjs'

function compactProject(p) {
  return {
    id: p._id.toString(),
    name: p.name,
    lastUpdated: p.lastUpdated,
    compiler: p.compiler,
  }
}

async function listProjects(req, res) {
  const q = (req.query.query || '').toLowerCase()
  const all = await ProjectGetter.promises.findAllUsersProjects(req.mcpUserId, {
    name: 1, lastUpdated: 1, compiler: 1,
  })
  let projects = [
    ...all.owned,
    ...all.readAndWrite,
    ...all.readOnly,
  ].map(compactProject)
  if (q) projects = projects.filter(p => p.name.toLowerCase().includes(q))
  res.json({ projects })
}

async function createProject(req, res) {
  const { name, initialFiles } = req.body || {}
  if (!name || typeof name !== 'string') {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'name is required')
  }
  const project = await ProjectCreationHandler.promises.createBlankProject(
    req.mcpUserId, name
  )
  for (const f of initialFiles || []) {
    await ProjectEntityUpdateHandler.promises.addDocWithRanges(
      project._id, project.rootFolder[0]._id, f.path, (f.content || '').split('\n'),
      { ranges: {} }, req.mcpUserId, 'mcp'
    )
  }
  res.json({ project: compactProject(project) })
}

async function getProject(req, res) {
  const project = await ProjectGetter.promises.getProject(req.params.projectId, {
    name: 1, compiler: 1, rootDoc_id: 1, spellCheckLanguage: 1,
  })
  if (!project) return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  res.json({
    project: {
      ...compactProject(project),
      rootDocId: project.rootDoc_id ? project.rootDoc_id.toString() : null,
      spellCheckLanguage: project.spellCheckLanguage,
    },
  })
}

async function updateSettings(req, res) {
  const { compiler, rootDocId, spellCheckLanguage } = req.body || {}
  if (compiler != null) {
    await EditorController.promises.setCompiler(req.params.projectId, compiler)
  }
  if (rootDocId != null) {
    await EditorController.promises.setRootDoc(req.params.projectId, rootDocId)
  }
  if (spellCheckLanguage != null) {
    await EditorController.promises.setSpellCheckLanguage(
      req.params.projectId, spellCheckLanguage
    )
  }
  res.json({ status: 'ok' })
}

export default { listProjects, createProject, getProject, updateSettings }
```

> Before writing, verify each manager method name against the tree (`grep -rn "createBlankProject\|addDocWithRanges\|setCompiler\|setRootDoc\|setSpellCheckLanguage\|findAllUsersProjects" app/src/Features/`). Adjust names/signatures to match; keep the controller thin.

- [ ] **Step 4: Implement `McpFilesController.mjs`**

```javascript
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import ProjectEntityUpdateHandler from '../Project/ProjectEntityUpdateHandler.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import McpErrors from './McpErrors.mjs'

function normalise(p) {
  return '/' + String(p || '').replace(/^\/+/, '')
}

async function findEntities(projectId) {
  return ProjectEntityHandler.promises.getAllEntitiesFromProject(projectId)
}

async function getTree(req, res) {
  const { docs, files } = await findEntities(req.params.projectId)
  res.json({
    docs: docs.map(d => ({ path: d.path, id: d.doc._id.toString() })),
    files: files.map(f => ({ path: f.path, id: f.file._id.toString() })),
  })
}

async function getDoc(req, res) {
  const path = normalise(req.query.path)
  const { docs } = await findEntities(req.params.projectId)
  const match = docs.find(d => normalise(d.path) === path)
  if (!match) return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  const { lines } = await DocstoreManager.promises.getDoc(
    req.params.projectId, match.doc._id
  )
  let out = lines
  const { startLine, endLine } = req.query
  if (startLine || endLine) {
    const s = startLine ? Math.max(1, parseInt(startLine, 10)) - 1 : 0
    const e = endLine ? Math.min(lines.length, parseInt(endLine, 10)) : lines.length
    out = lines.slice(s, e)
  }
  res.json({ path: req.query.path, content: out.join('\n') })
}

async function writeDoc(req, res) {
  const { path, content } = req.body || {}
  if (!path || typeof content !== 'string') {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'path and content are required')
  }
  const norm = normalise(path)
  const { docs } = await findEntities(req.params.projectId)
  let docId = docs.find(d => normalise(d.path) === norm)?.doc?._id
  if (!docId) {
    const folder = norm.slice(0, norm.lastIndexOf('/')) || '/'
    const name = norm.slice(norm.lastIndexOf('/') + 1)
    const { doc } = await ProjectEntityUpdateHandler.promises.addDoc(
      req.params.projectId, folder, name, content.split('\n'), req.mcpUserId, 'mcp'
    )
    docId = doc._id
  }
  await DocumentUpdaterHandler.promises.setDocument(
    req.params.projectId, docId.toString(), req.mcpUserId, content.split('\n'), 'mcp'
  )
  res.json({ status: 'ok', docId: docId.toString() })
}

async function createFolder(req, res) {
  const { path } = req.body || {}
  if (!path) return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'path is required')
  await ProjectEntityUpdateHandler.promises.mkdirp(
    req.params.projectId, normalise(path), req.mcpUserId
  )
  res.json({ status: 'ok' })
}

async function moveEntity(req, res) {
  const { oldPath, newPath } = req.body || {}
  if (!oldPath || !newPath) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'oldPath and newPath are required')
  }
  await ProjectEntityUpdateHandler.promises.moveEntityByPath(
    req.params.projectId, normalise(oldPath), normalise(newPath), req.mcpUserId, 'mcp'
  )
  res.json({ status: 'ok' })
}

export default { getTree, getDoc, writeDoc, createFolder, moveEntity }
```

> Same verification note: confirm `getAllEntitiesFromProject`, `getDoc` return shapes, `addDoc`/`mkdirp`/`moveEntityByPath` signatures against the tree and adjust.

- [ ] **Step 5: Register routes in `McpRouter.mjs`**

```javascript
    webRouter.get('/api/v0/mcp/projects', requireMcpAuth, McpProjectsController.listProjects)
    webRouter.post('/api/v0/mcp/projects', requireMcpAuth, McpProjectsController.createProject)
    webRouter.get('/api/v0/mcp/projects/:projectId', requireMcpAuth, requireMcpProjectRead, McpProjectsController.getProject)
    webRouter.patch('/api/v0/mcp/projects/:projectId/settings', requireMcpAuth, requireMcpProjectWrite, McpProjectsController.updateSettings)
    webRouter.get('/api/v0/mcp/projects/:projectId/tree', requireMcpAuth, requireMcpProjectRead, McpFilesController.getTree)
    webRouter.get('/api/v0/mcp/projects/:projectId/doc', requireMcpAuth, requireMcpProjectRead, McpFilesController.getDoc)
    webRouter.post('/api/v0/mcp/projects/:projectId/doc', requireMcpAuth, requireMcpProjectWrite, McpFilesController.writeDoc)
    webRouter.post('/api/v0/mcp/projects/:projectId/folder', requireMcpAuth, requireMcpProjectWrite, McpFilesController.createFolder)
    webRouter.post('/api/v0/mcp/projects/:projectId/move', requireMcpAuth, requireMcpProjectWrite, McpFilesController.moveEntity)
```

Wrap each async handler with the tree's async route helper if one is used (check how `GitBridgeApiController` handlers are registered — they are plain `async` there, so plain is acceptable, but add a `.catch` wrapper or `expressify` if that is the norm elsewhere in `router.mjs`).

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/unit/src/Features/Mcp`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(mcp): add projects and files endpoints"
```

---

## Task 8: Compile endpoints + wordcount + synctex

**Files:**
- Create: `app/src/Features/Mcp/McpCompileController.mjs`
- Modify: `app/src/Features/Mcp/McpRouter.mjs`
- Test: `test/unit/src/Features/Mcp/McpCompileController.test.mjs`

**Interfaces:**
- Consumes: `CompileManager.promises.compile(projectId, userId, options)`, `ClsiManager`/`CompileController` for `output.log` retrieval, `CompileManager.promises.deleteAuxFiles`, `CompileManager.promises.wordCount`, synctex helpers. Verify names against `app/src/Features/Compile/`.
- Produces: `compile`, `getLog`, `getPdf`, `clearCache`, `wordCount`, `synctex` handlers `(req, res)`.

- [ ] **Step 1: Write failing tests**

```javascript
describe('McpCompileController.compile', () => {
  it('passes compiler/draft options and returns a compact result', async () => {
    CompileManager.promises.compile.mockResolvedValue({
      status: 'success',
      outputFiles: [{ path: 'output.pdf', build: 'b1', url: '/x' }],
      stats: {}, timings: {},
    })
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { compiler: 'xelatex', draft: true } }
    const r = res()
    await McpCompileController.compile(req, r)
    expect(CompileManager.promises.compile).toHaveBeenCalledWith(
      'p1', 'u1', expect.objectContaining({ compiler: 'xelatex', draft: true })
    )
    expect(r.body.status).toBe('success')
    expect(r.body.pdf).toEqual({ build: 'b1', path: 'output.pdf' })
  })
})

describe('McpCompileController.wordCount', () => {
  it('returns the count payload', async () => {
    CompileManager.promises.wordCount.mockResolvedValue({ textWords: 1234 })
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, query: {} }
    const r = res()
    await McpCompileController.wordCount(req, r)
    expect(r.body.wordCount.textWords).toBe(1234)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/src/Features/Mcp/McpCompileController.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `McpCompileController.mjs`**

```javascript
import CompileManager from '../Compile/CompileManager.mjs'
import ClsiManager from '../Compile/ClsiManager.mjs'
import McpErrors from './McpErrors.mjs'

async function compile(req, res) {
  const { compiler, draft, stopOnFirstError } = req.body || {}
  const result = await CompileManager.promises.compile(
    req.params.projectId, req.mcpUserId,
    { compiler, draft: !!draft, stopOnFirstError: !!stopOnFirstError }
  )
  const pdfFile = (result.outputFiles || []).find(f => f.path === 'output.pdf')
  res.json({
    status: result.status,
    pdf: pdfFile ? { build: pdfFile.build, path: pdfFile.path } : null,
    outputFiles: (result.outputFiles || []).map(f => ({ path: f.path, build: f.build })),
  })
}

async function getLog(req, res) {
  const { buildId, maxLines } = req.query
  const files = await ClsiManager.promises.getOutputFilesForBuild(
    req.params.projectId, req.mcpUserId, buildId
  )
  const logFile = files.find(f => f.path === 'output.log')
  if (!logFile) return McpErrors.send(res, McpErrors.CODES.NOT_FOUND, 'no compile log')
  let text = await ClsiManager.promises.getOutputFileStream // fetch + read; see note
  // Implementation detail: reuse the same retrieval path CompileController uses for
  // /project/:id/output/output.log. Confirm the helper in app/src/Features/Compile/.
  if (maxLines) {
    const lines = String(text).split('\n')
    text = lines.slice(-parseInt(maxLines, 10)).join('\n')
  }
  res.json({ log: text })
}

async function getPdf(req, res) {
  const url = `/project/${req.params.projectId}/build/${req.query.buildId || ''}/output/output.pdf`
  res.json({ pdfUrl: url })
}

async function clearCache(req, res) {
  await CompileManager.promises.deleteAuxFiles(
    req.params.projectId, req.mcpUserId, null
  )
  res.json({ status: 'ok' })
}

async function wordCount(req, res) {
  const counts = await CompileManager.promises.wordCount(
    req.params.projectId, req.mcpUserId, req.query.file || null, null
  )
  res.json({ wordCount: counts })
}

async function synctex(req, res) {
  // Forward params to CompileManager.promises.syncFromCode / syncFromPdf based on inputs.
  const { file, line, column, page, h, v } = req.query
  let result
  if (page != null) {
    result = await CompileManager.promises.syncFromPdf(
      req.params.projectId, req.mcpUserId, parseInt(page, 10), parseFloat(h), parseFloat(v), null
    )
  } else {
    result = await CompileManager.promises.syncFromCode(
      req.params.projectId, req.mcpUserId, file, parseInt(line, 10), parseInt(column, 10), null
    )
  }
  res.json({ synctex: result })
}

export default { compile, getLog, getPdf, clearCache, wordCount, synctex }
```

> The `getLog` body has a marked detail — before implementing, `grep -rn "output.log" app/src/Features/Compile/CompileController.mjs` and reuse that exact retrieval helper. Do not leave the `getOutputFileStream` placeholder in the committed code.

- [ ] **Step 4: Register routes**

```javascript
    webRouter.post('/api/v0/mcp/projects/:projectId/compile', requireMcpAuth, requireMcpProjectRead, McpCompileController.compile)
    webRouter.get('/api/v0/mcp/projects/:projectId/compile/log', requireMcpAuth, requireMcpProjectRead, McpCompileController.getLog)
    webRouter.get('/api/v0/mcp/projects/:projectId/compile/pdf', requireMcpAuth, requireMcpProjectRead, McpCompileController.getPdf)
    webRouter.post('/api/v0/mcp/projects/:projectId/compile/clear-cache', requireMcpAuth, requireMcpProjectWrite, McpCompileController.clearCache)
    webRouter.get('/api/v0/mcp/projects/:projectId/wordcount', requireMcpAuth, requireMcpProjectRead, McpCompileController.wordCount)
    webRouter.get('/api/v0/mcp/projects/:projectId/synctex', requireMcpAuth, requireMcpProjectRead, McpCompileController.synctex)
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/unit/src/Features/Mcp`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(mcp): add compile, log, pdf, wordcount and synctex endpoints"
```

---

## Task 9: SSRF-guarded URL fetcher + figure upload endpoint

**Files:**
- Create: `app/src/Features/Mcp/McpUrlFetcher.mjs`
- Modify: `app/src/Features/Mcp/McpFilesController.mjs` (add `uploadFile`)
- Modify: `app/src/Features/Mcp/McpRouter.mjs`
- Test: `test/unit/src/Features/Mcp/McpUrlFetcher.test.mjs`
- Test: add cases to `test/unit/src/Features/Mcp/McpFilesController.test.mjs`

**Interfaces:**
- Produces: `McpUrlFetcher.fetchToBuffer(url, { maxBytes }) → Promise<{ buffer: Buffer, contentType: string }>`; throws `OError` tagged `{ code: 'ssrf_blocked' | 'too_large' | 'fetch_failed' }`.
- Produces: `McpFilesController.uploadFile(req, res)` — body `{ path, contentBase64? , url? }`; validates extension against `Settings.mcp.allowedUploadExtensions`, size against `Settings.mcp.maxUploadBytes`; stores via `FileStoreHandler` + `ProjectEntityUpdateHandler`.

- [ ] **Step 1: Write failing tests**

```javascript
// McpUrlFetcher.test.mjs
import { describe, it, expect } from 'vitest'
import McpUrlFetcher from '../../../../../app/src/Features/Mcp/McpUrlFetcher.mjs'

describe('McpUrlFetcher SSRF guard', () => {
  it('rejects localhost', async () => {
    await expect(McpUrlFetcher.fetchToBuffer('http://127.0.0.1/x', { maxBytes: 100 }))
      .rejects.toMatchObject({ info: { code: 'ssrf_blocked' } })
  })
  it('rejects private ranges', async () => {
    await expect(McpUrlFetcher.fetchToBuffer('http://10.0.0.5/x', { maxBytes: 100 }))
      .rejects.toMatchObject({ info: { code: 'ssrf_blocked' } })
  })
  it('rejects link-local metadata address', async () => {
    await expect(McpUrlFetcher.fetchToBuffer('http://169.254.169.254/latest/meta-data', { maxBytes: 100 }))
      .rejects.toMatchObject({ info: { code: 'ssrf_blocked' } })
  })
  it('rejects non-http(s) schemes', async () => {
    await expect(McpUrlFetcher.fetchToBuffer('file:///etc/passwd', { maxBytes: 100 }))
      .rejects.toMatchObject({ info: { code: 'ssrf_blocked' } })
  })
})
```

```javascript
// McpFilesController.test.mjs — add
describe('McpFilesController.uploadFile', () => {
  it('rejects a disallowed extension', async () => {
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { path: 'x.exe', contentBase64: 'AA==' } }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.statusCode).toBe(400)
    expect(r.body.code).toBe('validation_error')
  })
  it('rejects an oversize base64 payload', async () => {
    const big = Buffer.alloc(Settings.mcp.maxUploadBytes + 1).toString('base64')
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { path: 'x.png', contentBase64: big } }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.statusCode).toBe(400)
  })
  it('stores an allowed base64 image', async () => {
    FileStoreHandler.promises.uploadFileFromDisk.mockResolvedValue({ fileRef: { _id: 'f1' }, url: 'u' })
    // ...mock ProjectEntityUpdateHandler.addFile...
    const req = { mcpUserId: 'u1', params: { projectId: 'p1' }, body: { path: 'figs/plot.png', contentBase64: Buffer.from('x').toString('base64') } }
    const r = res()
    await McpFilesController.uploadFile(req, r)
    expect(r.body.status).toBe('ok')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/src/Features/Mcp/McpUrlFetcher.test.mjs test/unit/src/Features/Mcp/McpFilesController.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement `McpUrlFetcher.mjs`**

```javascript
import dns from 'node:dns/promises'
import net from 'node:net'
import OError from '@overleaf/o-error'

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  const low = ip.toLowerCase()
  return low === '::1' || low.startsWith('fc') || low.startsWith('fd') ||
    low.startsWith('fe80') || low === '::'
}

async function fetchToBuffer(url, { maxBytes }) {
  let parsed
  try { parsed = new URL(url) } catch {
    throw new OError('invalid url', { code: 'ssrf_blocked' })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OError('scheme not allowed', { code: 'ssrf_blocked' })
  }
  const { address } = await dns.lookup(parsed.hostname)
  if (isBlockedIp(address)) {
    throw new OError('blocked address', { code: 'ssrf_blocked', address })
  }
  const resp = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) })
  if (!resp.ok) throw new OError('fetch failed', { code: 'fetch_failed', status: resp.status })
  const chunks = []
  let total = 0
  for await (const chunk of resp.body) {
    total += chunk.length
    if (total > maxBytes) throw new OError('response too large', { code: 'too_large' })
    chunks.push(chunk)
  }
  return { buffer: Buffer.concat(chunks), contentType: resp.headers.get('content-type') || '' }
}

export default { fetchToBuffer, isBlockedIp }
export { fetchToBuffer, isBlockedIp }
```

- [ ] **Step 4: Implement `uploadFile` in `McpFilesController.mjs`**

```javascript
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Settings from '@overleaf/settings'
import FileStoreHandler from '../FileStore/FileStoreHandler.mjs'
import McpUrlFetcher from './McpUrlFetcher.mjs'

async function uploadFile(req, res) {
  const { path: target, contentBase64, url } = req.body || {}
  if (!target) return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'path is required')
  const ext = target.split('.').pop().toLowerCase()
  if (!Settings.mcp.allowedUploadExtensions.includes(ext)) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, `extension .${ext} not allowed`)
  }
  let buffer
  if (contentBase64) {
    buffer = Buffer.from(contentBase64, 'base64')
    if (buffer.length > Settings.mcp.maxUploadBytes) {
      return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'file too large')
    }
  } else if (url) {
    try {
      ;({ buffer } = await McpUrlFetcher.fetchToBuffer(url, {
        maxBytes: Settings.mcp.maxUploadBytes,
      }))
    } catch (err) {
      return McpErrors.send(res, McpErrors.CODES.VALIDATION, `url fetch rejected: ${err.info?.code || 'error'}`)
    }
  } else {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'contentBase64 or url is required')
  }
  const tmp = path.join(os.tmpdir(), `mcp-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.writeFile(tmp, buffer)
  try {
    const norm = normalise(target)
    const folder = norm.slice(0, norm.lastIndexOf('/')) || '/'
    const name = norm.slice(norm.lastIndexOf('/') + 1)
    await ProjectEntityUpdateHandler.promises.upsertFileWithPath(
      req.params.projectId, norm, tmp, null, name, req.mcpUserId, 'mcp'
    )
    res.json({ status: 'ok', path: target })
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}
```

> Verify `upsertFileWithPath` (or the correct add-file-from-disk method) signature in `ProjectEntityUpdateHandler.mjs`; some trees use `FileStoreHandler.uploadFileFromDisk` then `ProjectEntityUpdateHandler.addFile`. Match the tree.

- [ ] **Step 5: Register route**

```javascript
    webRouter.post('/api/v0/mcp/projects/:projectId/file', requireMcpAuth, requireMcpProjectWrite, McpFilesController.uploadFile)
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/unit/src/Features/Mcp`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(mcp): add SSRF-guarded figure/asset upload endpoint"
```

---

## Task 10: Per-token rate limiting

**Files:**
- Modify: `app/src/Features/Mcp/McpRouter.mjs`
- Modify: `config/settings.defaults.js` (rate-limiter entry if the tree keeps them there — check `rateLimiters` usage in `router.mjs`)
- Test: `test/unit/src/Features/Mcp/McpRouter.test.mjs` (assert middleware present on routes)

**Interfaces:**
- Consumes: `RateLimiterMiddleware.rateLimit(...)` — check the exact factory signature in `app/src/infrastructure/RateLimiterMiddleware.mjs` and how git-bridge / tags routes use it.
- Produces: an `mcpRateLimit` middleware keyed on `req.mcpTokenPrefix + ':' + req.mcpUserId`, applied after `requireMcpAuth` on every `/api/v0/mcp/*` route.

- [ ] **Step 1: Write failing test**

```javascript
it('applies a rate-limit middleware after auth on mcp routes', async () => {
  vi.doMock('@overleaf/settings', () => ({ default: { enableMcp: true, mcp: { maxUploadBytes: 1, allowedUploadExtensions: [] } } }))
  const calls = []
  const webRouter = new Proxy({}, { get: () => (...args) => calls.push(args) })
  const { default: McpRouter } = await import('../../../../../app/src/Features/Mcp/McpRouter.mjs?rate')
  McpRouter.apply(webRouter)
  // every registered route has >= 3 handlers: requireMcpAuth, mcpRateLimit, ...
  for (const c of calls) {
    const handlers = c.slice(1).map(h => h.name || 'anon')
    expect(handlers).toContain('mcpRateLimit')
  }
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/src/Features/Mcp/McpRouter.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

Define `mcpRateLimit` in `McpRouter.mjs` (named function so the test can see it) using the tree's `RateLimiterMiddleware`. Example shape (adjust to the real API):

```javascript
import RateLimiterMiddleware from '../../infrastructure/RateLimiterMiddleware.mjs'

const mcpRateLimit = RateLimiterMiddleware.rateLimit({
  endpointName: 'mcp-api',
  ipOnly: false,
  params: [],
  maxRequests: 200,
  timeInterval: 60,
  // key the limiter on the token, not the IP:
  getUserId: req => `${req.mcpTokenPrefix}:${req.mcpUserId}`,
})
```

Insert `mcpRateLimit` as the second handler on every `/api/v0/mcp/*` route (right after `requireMcpAuth`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/src/Features/Mcp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mcp): rate limit mcp api per token"
```

---

## Task 11: Account-settings UI — token scope selector

**Files:**
- Modify: the existing PAT / git-token settings React component and its locale strings. Find it: `grep -rn "personal-access-token\|personalAccessToken\|Git Token" app/src/Features/*/ frontend/ locales/en.json`
- Modify: `PersonalAccessTokenController.createToken` to accept and validate `req.body.scopes`
- Test: `test/unit/src/Features/PersonalAccessToken/PersonalAccessTokenController.test.mjs`; frontend test alongside the component if the tree has one

**Interfaces:**
- Consumes: `PersonalAccessTokenManager.createToken(userId, name, scopes)` (Task 2), `ALLOWED_SCOPES`.
- Produces: `POST /user/personal-access-tokens` body accepts `{ name, scopes: string[] }`; response unchanged plus `scopes`. List response includes `scopes` per token.

- [ ] **Step 1: Write failing controller test**

```javascript
it('createToken passes through the requested scopes', async () => {
  const req = { session: { user: { _id: 'u1' } }, body: { name: 'AI', scopes: ['mcp'] } }
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
  await PersonalAccessTokenController.createToken(req, res)
  expect(createTokenSpy).toHaveBeenCalledWith('u1', 'AI', ['mcp'])
})

it('createToken rejects an unknown scope with 400', async () => {
  const req = { session: { user: { _id: 'u1' } }, body: { name: 'x', scopes: ['root'] } }
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
  await PersonalAccessTokenController.createToken(req, res)
  expect(res.status).toHaveBeenCalledWith(400)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/src/Features/PersonalAccessToken/PersonalAccessTokenController.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement controller change**

In `PersonalAccessTokenController.createToken`: read `req.body.scopes`, default `['git_bridge']` if absent, 400 (`{ code: 'validation_error' }`) if any not in `ALLOWED_SCOPES`, pass to `createToken`. Include `scopes` in `listTokens` output (already returned by the model projection — confirm `tokenHash: 0` projection doesn't also drop `scopes`).

- [ ] **Step 4: Frontend — add scope checkboxes**

In the token-creation form component, add two checkboxes: "Git integration" (`git_bridge`) and "AI assistant (MCP)" (`mcp`); default "Git integration" checked. Submit the selected values as `scopes`. Add the two locale keys to `locales/en.json` (`personal_access_token_scope_git_bridge`, `personal_access_token_scope_mcp`). In the token list, render the `scopes` badges and the existing `lastUsedAt`.

Gate the "AI assistant (MCP)" checkbox visibility on a `enableMcp` flag passed to the page (mirror how `enableGitBridge` reaches this component).

- [ ] **Step 5: Run available tests**

Run: `npx vitest run test/unit/src/Features/PersonalAccessToken`
Frontend: run the component's test if present; otherwise note it is deferred (per repo test-runner constraints).
Expected: backend PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(pat): let users choose token scope (git / mcp) in account settings"
```

---

## Task 12: Acceptance tests — authoring cycle + isolation gate

**Files:**
- Create: `test/acceptance/src/McpTests.mjs`
- Reference: an existing acceptance test that logs in a user and creates a project (`grep -rln "createProject\|UserHelper" test/acceptance/src | head`)

**Interfaces:**
- Consumes: the acceptance harness `User`/`UserHelper` helpers, `Settings.enableMcp` forced true for this suite (`test/acceptance` bootstrap env or per-suite override — check how git-bridge acceptance mocks set `enableGitBridge`).

- [ ] **Step 1: Write the authoring-cycle acceptance test**

```javascript
import { expect } from 'chai'
import UserHelper from './helpers/UserHelper.mjs' // match the real helper path

describe('MCP API — authoring cycle', function () {
  let userA, tokenA, projectId
  before(async function () {
    userA = new UserHelper()
    await userA.login()
    const { body } = await userA.doRequest('POST', {
      url: '/user/personal-access-tokens',
      json: { name: 'mcp', scopes: ['mcp'] },
    })
    tokenA = body.token
  })

  function mcp(method, path, json) {
    return userA.doRequest(method, {
      url: path, json: json || true,
      headers: { Authorization: `Bearer ${tokenA}` },
    })
  }

  it('creates a project, writes a doc, compiles', async function () {
    let r = await mcp('POST', '/api/v0/mcp/projects', { name: 'Acceptance Thesis' })
    expect(r.response.statusCode).to.equal(200)
    projectId = r.body.project.id

    r = await mcp('POST', `/api/v0/mcp/projects/${projectId}/doc`, {
      path: 'main.tex',
      content: '\\documentclass{article}\\begin{document}hi\\end{document}',
    })
    expect(r.body.status).to.equal('ok')

    r = await mcp('GET', `/api/v0/mcp/projects/${projectId}/doc?path=main.tex`)
    expect(r.body.content).to.contain('documentclass')

    r = await mcp('POST', `/api/v0/mcp/projects/${projectId}/compile`, {})
    expect(['success', 'failure']).to.include(r.body.status)
  })
})
```

- [ ] **Step 2: Write the isolation-gate acceptance test**

```javascript
describe('MCP API — cross-user isolation (RELEASE GATE)', function () {
  let userA, userB, tokenB, gitTokenB, aProjectId

  before(async function () {
    userA = new UserHelper(); await userA.login()
    userB = new UserHelper(); await userB.login()

    const a = await userA.doRequest('POST', {
      url: '/user/personal-access-tokens', json: { name: 'mcp', scopes: ['mcp'] },
    })
    const aTok = a.body.token
    const p = await userA.doRequest('POST', {
      url: '/api/v0/mcp/projects', json: { name: 'A private' },
      headers: { Authorization: `Bearer ${aTok}` },
    })
    aProjectId = p.body.project.id

    tokenB = (await userB.doRequest('POST', {
      url: '/user/personal-access-tokens', json: { name: 'mcp', scopes: ['mcp'] },
    })).body.token
    gitTokenB = (await userB.doRequest('POST', {
      url: '/user/personal-access-tokens', json: { name: 'git', scopes: ['git_bridge'] },
    })).body.token
  })

  const asB = (method, path, tok = tokenB, json = true) =>
    userB.doRequest(method, { url: path, json, headers: { Authorization: `Bearer ${tok}` } })

  it("B's mcp token cannot read A's project (404)", async function () {
    const r = await asB('GET', `/api/v0/mcp/projects/${aProjectId}`)
    expect(r.response.statusCode).to.equal(404)
  })
  it("B's mcp token cannot read A's project tree (404)", async function () {
    const r = await asB('GET', `/api/v0/mcp/projects/${aProjectId}/tree`)
    expect(r.response.statusCode).to.equal(404)
  })
  it("B's mcp token cannot write A's project (404)", async function () {
    const r = await asB('POST', `/api/v0/mcp/projects/${aProjectId}/doc`, tokenB, { path: 'x.tex', content: 'x' })
    expect(r.response.statusCode).to.equal(404)
  })
  it("B's mcp token cannot compile A's project (404)", async function () {
    const r = await asB('POST', `/api/v0/mcp/projects/${aProjectId}/compile`, tokenB, {})
    expect(r.response.statusCode).to.equal(404)
  })
  it("B's git-only token is rejected on the mcp api (403 insufficient_scope)", async function () {
    const r = await asB('GET', '/api/v0/mcp/projects', gitTokenB)
    expect(r.response.statusCode).to.equal(403)
    expect(r.body.code).to.equal('insufficient_scope')
  })
  it('B as a read-only collaborator can read but not write', async function () {
    // userA shares aProjectId read-only with userB (use the existing share helper),
    // then:
    let r = await asB('GET', `/api/v0/mcp/projects/${aProjectId}/tree`)
    expect(r.response.statusCode).to.equal(200)
    r = await asB('POST', `/api/v0/mcp/projects/${aProjectId}/doc`, tokenB, { path: 'x.tex', content: 'x' })
    expect(r.response.statusCode).to.equal(403)
    expect(r.body.code).to.equal('forbidden')
  })
})
```

- [ ] **Step 3: Run the acceptance suite**

Run: `MOCHA_GREP='MCP API' yarn run test:acceptance:app` (or the repo's documented acceptance command; this needs the full docker acceptance stack — if the sandbox cannot run it, hand this task to the user with the command and expected output).
Expected: all green. **The isolation-gate describe block must pass before Plan 2 enables the feature anywhere.**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(mcp): acceptance tests for authoring cycle and cross-user isolation gate"
```

---

## Task 13: Docs

**Files:**
- Create: `docs/mcp/web-api.md` — the `/api/v0/mcp/*` endpoint reference (methods, params, error codes, auth model)
- Modify: `docs/superpowers/specs/2026-09-04-overleaf-mcp-per-user-auth-design.md` — add a "Status: Plan 1 implemented" note with the commit range

- [ ] **Step 1: Write `docs/mcp/web-api.md`**

Document: the token model + `mcp` scope, how to mint a token, the full endpoint table from spec §6 with request/response JSON examples, the error envelope table from §9, and the explicit statement that a token is scoped to its owner's projects and that `404` is returned for both missing and inaccessible projects.

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "docs(mcp): document the per-user web api"
```

---

## Self-Review

**Spec coverage:**
- §5.1 token model — unchanged, Task 2 keeps `[String]` scopes. ✓
- §5.2 extraction — Task 1. ✓
- §5.3 scopes + route decoupling + UI — Tasks 2, 1 (router), 11. ✓
- §5.4 `requireMcpAuth` (header-only, scope) — Task 5. ✓
- §5.5 authz middleware (404 masks no-access; 403 for privilege) — Task 6. ✓
- §5.6 rate limiting — Task 10; audit log line — Task 5 (`logger.info` in `requireMcpAuth`). ✓
- §6 endpoints — Tasks 7 (projects/files), 8 (compile family), 9 (upload). `edit_file` + semantic tools are Plan 2 (in-service). ✓
- §7 microservice — Plan 2. ✓ (out of scope here, stated)
- §8 figure upload + SSRF — Task 9. ✓
- §9 error envelope — Task 4. ✓
- §10 config — Task 3 (`web`); server-ce runit/nginx/compose — Plan 2. ✓
- §11 testing — unit tests each task; acceptance + isolation gate Task 12. ✓
- §12 security checklist — enforced by Task 6 semantics + Task 5 + Task 12 gate; add a checklist run to the PR description. ✓
- §13 work breakdown item 1 (remove old worktree, new worktree) — handled by the executing skill's worktree setup, noted in the handoff below, not a code task. ✓

**Placeholder scan:** `McpCompileController.getLog` and a few controller methods carry explicit "verify the manager method name / retrieval helper against the tree" notes with a concrete `grep` to run — these are verification steps, not deferred logic; the surrounding code is complete. The `getOutputFileStream` line is explicitly flagged as must-not-commit. Acceptable but the executor must resolve them within the task.

**Type consistency:** `validateToken` returns `{ userId, email, scopes }` (Task 2) and is consumed as `.userId` / `.scopes` in Task 5 and in `GitBridgeApiController` (Task 2 Step 4). `req.mcpUserId` / `req.mcpScopes` / `req.mcpTokenPrefix` set in Task 5, read in Tasks 6–10. `McpErrors.CODES` constants consistent across Tasks 4–9. Route handler names match between controller exports and `McpRouter` registrations in Tasks 7–9.

**Known soft spots the executor must close (not placeholders, but confirm-in-tree):** exact `ProjectEntityUpdateHandler` / `CompileManager` / `FileStoreHandler` method names and signatures; the `output.log` retrieval helper; the `RateLimiterMiddleware.rateLimit` option names; the acceptance `UserHelper` path and share helper. Each task names the `grep` to run first.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-04-overleaf-mcp-web-auth-layer.md`.

**Pre-req before Task 1:** remove the `worktree-overleaf-mcp-feature` worktree and create a fresh worktree from `main` (the executing skill's worktree setup step). The old scaffold's reusable parts (tool schemas, LaTeX/BibTeX parsers) are salvaged in **Plan 2**, not this plan.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
