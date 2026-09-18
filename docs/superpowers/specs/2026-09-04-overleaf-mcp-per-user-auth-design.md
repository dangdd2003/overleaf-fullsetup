# Overleaf MCP — Per-User Auth & Fine-Grained Endpoints (Design)

**Date:** 2026-09-04
**Status:** Draft for review
**Supersedes:** the uncommitted `worktree-overleaf-mcp-feature` scaffold (to be removed; reusable parts salvaged)

---

## 1. Problem

The existing MCP microservice scaffold (`overleaf/services/mcp/`, ~55 tools across 8 domains)
is a functional MCP *scaffold* but is **not safe to enable**:

1. **No per-user scoping.** The service extracts a bearer token and forwards it verbatim to
   Overleaf. It never resolves the token to a user and never checks project authorization.
   The routes it calls either do not exist (`/api/v0/projects`) or sit on `privateApiRouter`
   behind the internal shared secret (`POST /project/:id/doc/:doc_id`), which grants
   instance-wide access with no per-user checks. Enabling it on a multi-user instance =
   full cross-tenant exposure.
2. **Broken MCP handshake.** The hand-rolled HTTP+SSE transport handles only `tools/list`
   and `tools/call`; it never answers `initialize`, so spec-compliant clients hang.
3. **Ambient credential.** `OVERLEAF_DEFAULT_TOKEN` is a shared standing credential.
4. **Unverified end-to-end.** No test has ever run against a live Overleaf instance.

## 2. Goal

A user's MCP token grants an AI assistant **exactly the access that user already has** —
their own projects and projects shared with them — and **nothing instance-wide or
belonging to other users**. Every tool operation is authorization-checked per request.
The feature is modular and disabled by default; pure CE is unaffected.

### In scope (this cycle)

- Reuse the existing `personalAccessTokens` MongoDB collection for token → user resolution.
- New `web` module `Features/Mcp/` exposing `/api/v0/mcp/*` REST endpoints, each guarded by
  a single auth + authorization middleware chain that delegates to existing `web` managers.
- Rebuild `services/mcp/` on the official `@modelcontextprotocol/sdk` (Streamable HTTP +
  stdio) as a thin protocol adapter with no auth or business logic.
- Tool coverage: **authoring core** — projects, files, compile, LaTeX-semantic (read-only
  parsers), plus **figure/asset upload**.
- Extract the PAT manager/controller out of `Features/GitBridge/` into
  `Features/PersonalAccessToken/`; add and enforce token **scopes** (`git_bridge`, `mcp`).

### Out of scope (follow-up specs)

- Tags, collaboration, comments, history/version tools.
- Real-time OT co-editing semantics beyond what `document-updater` already provides.
- Visual/PDF-content feedback to the model.
- Single-file version restore.

## 3. Approach

**Chosen: dedicated `Features/Mcp/` module in `web` + thin proxy service** (mirrors the
git-bridge pattern). The entire security boundary is one auditable middleware chain in one
module; `web`'s battle-tested `AuthorizationManager` is reused rather than reimplemented;
the microservice stays independently toggleable and modular per project rules.

Rejected:
- *MCP service validates then calls scattered existing web routes with an internal
  privileged credential* — spreads security-critical logic across many call sites, mixes a
  privileged transport with per-user checks.
- *Embed the MCP server inside the `web` process* — strongest isolation but couples MCP
  lifecycle/deps to an already large service and breaks the service-per-concern layout.

## 4. Architecture

```
AI client (Claude Desktop/Code, Cursor, Windsurf)
      │  MCP protocol (Streamable HTTP or stdio)
      │  Authorization: Bearer olp_…
      ▼
overleaf-mcp  (separate container — "dumb" adapter)
      │  @modelcontextprotocol/sdk McpServer
      │  ~30 authoring-core tools: zod schema + handler
      │  handler = validate args → HTTP call to web, forwarding the user token
      │  NO auth logic · NO DB · NO business logic
      ▼  HTTP  Authorization: Bearer olp_…  →  http://web:3000/api/v0/mcp/*
web : Features/Mcp/   (the entire security boundary)
      │  McpRouter.mjs                → route table, gated on Settings.enableMcp
      │  McpAuthMiddleware.mjs        → requireMcpAuth: token → userId + 'mcp' scope
      │  McpAuthorizationMiddleware   → requireMcpProjectRead / requireMcpProjectWrite
      │  McpController.mjs            → thin; delegates to existing managers
      ▼
existing managers: ProjectGetter, ProjectCreationHandler, EditorController,
      ProjectEntityHandler, ProjectEntityUpdateHandler, DocumentUpdaterHandler.setDocument,
      DocstoreManager, CompileController, ClsiManager, FileStoreHandler,
      ProjectRootDocManager, CountController
```

### New / moved components

| Path | Purpose |
|---|---|
| `web/app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs` | moved from `Features/GitBridge/`; `createToken/validateToken/listTokens/revokeToken` |
| `web/app/src/Features/PersonalAccessToken/PersonalAccessTokenController.mjs` | moved from `Features/GitBridge/`; `/user/personal-access-tokens` CRUD |
| `web/app/src/models/PersonalAccessToken.mjs` | unchanged (already neutral, collection `personalAccessTokens`) |
| `web/app/src/Features/Mcp/McpRouter.mjs` | route table, `apply(webRouter, privateApiRouter, publicApiRouter)` |
| `web/app/src/Features/Mcp/McpAuthMiddleware.mjs` | `requireMcpAuth` |
| `web/app/src/Features/Mcp/McpAuthorizationMiddleware.mjs` | `requireMcpProjectRead`, `requireMcpProjectWrite` |
| `web/app/src/Features/Mcp/McpController.mjs` | endpoint handlers, delegate-only |
| `services/mcp/` | rebuilt on official SDK; see §7 |

### Salvaged from the old scaffold

Keep (pure functions + tests): zod tool schemas, `src/utils/latexSectionParser.ts`,
`src/utils/bibtexParser.ts`, `src/client/LaTeXLogParser.ts`, `src/utils/validation.ts`,
their `test/unit/*` suites, the tool README catalog (trimmed to authoring core).

Discard: `src/server.ts`, `src/transports/http-sse.ts`, `src/transports/stdio.ts` (old),
`src/client/OverleafApiClient.ts` (auth + route assumptions), old app entrypoint wiring.

## 5. Auth layer

### 5.1 Token model — unchanged

`personalAccessTokens`: `user_id`, `name`, `tokenHash` (sha256, unique index), `tokenPrefix`,
`scopes: string[]`, `createdAt`, `expiresAt` (default +1 year), `lastUsedAt`.

### 5.2 Extraction

Move `PersonalAccessTokenManager` + `PersonalAccessTokenController` to
`Features/PersonalAccessToken/`. `GitBridgeRouter` imports from the new location. No
behavior change for git-bridge. `Oauth2TokenInfoController`, `GitBridgeApiController`,
`GitBridgeFileTokenManager`, `GitBridgeSnapshotManager` stay in `Features/GitBridge/`.

### 5.3 Scopes

- `createToken(userId, name, scopes)` — `scopes` defaults to `['git_bridge']` when omitted
  (backward compatible).
- `validateToken(raw)` returns `{ userId, email, scopes: string[] }` (change the current
  join-to-string to return the array).
- Token CRUD routes `/user/personal-access-tokens` (POST/GET/DELETE) mount when
  `Settings.enableGitBridge || Settings.enableMcp` (currently git-bridge only).
- Create endpoint accepts a `scopes` field (validated against the allowed set).
- Account-settings UI: scope selector — "Git integration" (`git_bridge`),
  "AI assistant (MCP)" (`mcp`); a token may hold both. List view shows prefix, scopes,
  `createdAt`, `lastUsedAt`, `expiresAt`.

### 5.4 `requireMcpAuth` (`McpAuthMiddleware.mjs`)

1. Extract bearer token from the `Authorization` header **only** — no query-string or body
   fallback.
2. `PersonalAccessTokenManager.validateToken(token)` → `401 unauthorized` if
   missing / unknown / expired.
3. Assert `'mcp' ∈ scopes` → `403 insufficient_scope` otherwise.
4. Set `req.mcpUserId`, `req.mcpTokenPrefix`.
5. `lastUsedAt` write throttled — only when the stored value is > 60 s stale.

### 5.5 `requireMcpProjectRead` / `requireMcpProjectWrite` (`McpAuthorizationMiddleware.mjs`)

- Read `req.mcpUserId` and `req.params.projectId`.
- `AuthorizationManager.promises.canUserReadProject(userId, projectId, null)` /
  `canUserWriteProjectContent(userId, projectId, null)`.
- Deny → `403 forbidden`. Project not found / cast error → `404 not_found`.
- **No-access and not-found both return `404 not_found` to the caller** — no project
  existence leak. (`403 forbidden` is reserved for the authenticated user lacking the
  needed privilege level on a project they *can* see, e.g. read-only collaborator hitting a
  write route.)

### 5.6 Rate limiting & audit

- `RateLimiterMiddleware` per token (`tokenPrefix` + `mcpUserId` key) on all `/api/v0/mcp/*`.
- Every request logs `{ mcpUserId, mcpTokenPrefix, route, projectId, outcome, status }` at
  info level.

## 6. `web` `/api/v0/mcp/*` endpoints

All behind `requireMcpAuth` + per-token rate limit. Project routes add the noted authz
middleware. Responses are uniform JSON (see §9).

| Method & path | Delegates to | Authz |
|---|---|---|
| `GET /api/v0/mcp/projects` | `ProjectGetter` — projects owned by or shared with `mcpUserId` | auth only |
| `POST /api/v0/mcp/projects` | `ProjectCreationHandler` (+ optional `initialFiles[]`) | auth only |
| `GET /api/v0/mcp/projects/:projectId` | `ProjectGetter` + root doc + compiler | read |
| `PATCH /api/v0/mcp/projects/:projectId/settings` | `EditorController` — `compiler`, `rootDocId`, `spellCheckLanguage` | write |
| `GET /api/v0/mcp/projects/:projectId/tree` | `ProjectEntityHandler` | read |
| `GET /api/v0/mcp/projects/:projectId/doc?path=&startLine=&endLine=` | `ProjectEntityHandler` + `DocstoreManager`; line-range sliced in controller | read |
| `POST /api/v0/mcp/projects/:projectId/doc` — `{ path, content }` | resolve or create docId → `DocumentUpdaterHandler.setDocument(projectId, docId, userId, lines, source:'mcp')` | write |
| `POST /api/v0/mcp/projects/:projectId/folder` — `{ path }` | `ProjectEntityUpdateHandler.mkdirp` | write |
| `POST /api/v0/mcp/projects/:projectId/move` — `{ oldPath, newPath }` | `ProjectEntityUpdateHandler` (move/rename entity) | write |
| `POST /api/v0/mcp/projects/:projectId/file` — `{ path, contentBase64 \| url }` | §8 | write |
| `POST /api/v0/mcp/projects/:projectId/compile` — `{ compiler?, draft?, stopOnFirstError? }` | `CompileController` → `{ status, outputFiles, stats, buildId }` | read |
| `GET /api/v0/mcp/projects/:projectId/compile/log?buildId=&maxLines=` | `CompileController` `output.log` | read |
| `GET /api/v0/mcp/projects/:projectId/compile/pdf?buildId=` | signed PDF download URL | read |
| `POST /api/v0/mcp/projects/:projectId/compile/clear-cache` | `ClsiManager` / `CompileManager.deleteAuxFiles` | write |
| `GET /api/v0/mcp/projects/:projectId/wordcount` | `CompileController.wordCount` | read |
| `GET /api/v0/mcp/projects/:projectId/synctex?...` | `CompileController` synctex forward/inverse | read |

### Handled in the microservice, no new endpoint

- `edit_file` (surgical string replace): GET doc → replace in memory → POST doc.
- All LaTeX-semantic tools (document outline, section content, include tree, citations,
  bibliography parse/search, labels/refs, equations, figures/tables, custom commands, TODO
  notes): run on document text fetched via `GET .../doc` and `GET .../tree`.

## 7. MCP microservice

- **SDK:** `@modelcontextprotocol/sdk` `McpServer`. Transports: **Streamable HTTP**
  (`MCP_ENDPOINT_PATH`, default `/mcp`) and **stdio**. The SDK owns `initialize`,
  capability negotiation, notifications, and session IDs.
- **Auth:**
  - HTTP transport requires `Authorization: Bearer olp_…`; the token is captured per
    session/request and forwarded on every downstream `web` call.
  - stdio transport reads the token from `OVERLEAF_MCP_TOKEN` (single-user local use).
  - **`OVERLEAF_DEFAULT_TOKEN` / `OVERLEAF_TOKEN` removed.** No ambient credential.
- **`OverleafClient`:** thin `fetch` wrapper over `OVERLEAF_INTERNAL_URL`; always forwards
  the caller token; maps `web` HTTP `401/403/404/429/4xx/5xx` → structured MCP tool errors
  preserving the `code`; never surfaces internal URLs or stack traces to the model.
- **Tools registered:** authoring core only (~30) — projects, files, compile,
  latex-semantic. Others deferred.
- **Config:** `MCP_PORT` (3050), `MCP_ENDPOINT_PATH` (`/mcp`), `OVERLEAF_INTERNAL_URL`
  (falls back to `OVERLEAF_URL`), `MCP_MAX_UPLOAD_MB` (default 20), `LOG_LEVEL`,
  `OVERLEAF_MCP_ENABLED` (default `false` — service exits if unset/false).
- CORS: not `*` — restrict to configured origins; localhost bind by default for the raw
  service (nginx terminates external traffic); never log tokens.

## 8. Figure / asset upload

- Tool `upload_file` → `POST /api/v0/mcp/projects/:projectId/file`, body `{ path }` plus
  either `contentBase64` or `url`.
- `web` controller:
  - MIME/extension allowlist: `png, jpg/jpeg, pdf, eps, svg, gif, csv, bib, txt`.
  - Size cap from config (`Settings.mcp.maxUploadBytes`, default 20 MB); reject larger.
  - `url` fetched server-side with an **SSRF guard**: resolve host, reject private/loopback/
    link-local/metadata ranges, cap redirects, cap download size, timeout.
  - Store via `FileStoreHandler` + `ProjectEntityUpdateHandler.addFile` (creates parent
    folders as needed). Write authz required.

## 9. Error handling

Uniform JSON body from `web`: `{ code, message }`.

| `code` | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | missing / invalid / expired token |
| `insufficient_scope` | 403 | valid token without `mcp` scope |
| `forbidden` | 403 | user can see the project but lacks the required privilege (e.g. RO hitting a write route) |
| `not_found` | 404 | project/doc absent **or** user has no access (indistinguishable) |
| `validation_error` | 400 | bad arguments |
| `rate_limited` | 429 | per-token limit hit |
| `upstream_error` | 502 | downstream service (clsi, docstore, doc-updater) failed |

The microservice maps each to an MCP tool-call error, preserving `code` in the error data.

## 10. Config & deployment

- **`web`:** `OVERLEAF_MCP_ENABLED` → `Settings.enableMcp` (default `false`).
  `McpRouter.apply` returns early when disabled; PAT-route decoupling also checks it.
- **`server-ce`:** `services.js` gains an `mcp` entry; `runit/mcp/` daemon guarded by
  `OVERLEAF_MCP_ENABLED`; nginx `location /mcp` → `http://mcp:3050` with proxy buffering
  off and streaming headers for Streamable HTTP.
- **`develop/docker-compose.yml`:** `mcp` service, `depends_on: web`, host bind `0.0.0.0`,
  port allocated per worktree convention, named volumes only, compose project name = the
  worktree name.
- **Default state:** pure CE unaffected. Both the `web` module and the service are inert
  unless `OVERLEAF_MCP_ENABLED=true`.

## 11. Testing

### `web`

- Unit — `requireMcpAuth`: valid / expired / unknown / malformed / wrong-scope.
- Unit — authorization middleware: owner, RW collaborator, RO collaborator (→ 403 on write,
  200 on read), non-member (→ 404), missing project (→ 404).
- Unit — each `McpController` method with mocked managers (happy path + manager error →
  `upstream_error`).
- Acceptance — full authoring cycle with a real `mcp`-scoped token: create project → add
  folder → write doc → read doc (range) → edit doc → upload figure → compile → read log →
  wordcount.

### Isolation acceptance test — **release gate**

- User B holds an `mcp` token. For every `/api/v0/mcp/projects/:projectId/*` route against
  a project owned solely by user A: expect `404 not_found`.
- User B is a read-only collaborator on user A's project: read routes `200`, write routes
  `403 forbidden`.
- A `git_bridge`-only token against any `/api/v0/mcp/*` route: `403 insufficient_scope`.
- The `mcp` token against git-bridge's `/api/v0/docs/*`: `403` (scope mismatch) — confirms
  the two features do not bleed.

### microservice

- Keep parser/schema unit suites.
- Transport test: SDK `initialize` → `tools/list` → `tools/call` against a mocked `web`;
  assert handshake completes and tool errors carry the upstream `code`.
- Auth: HTTP request without a bearer token is refused before any downstream call.

> Sandbox note: npm/yarn registry is blocked in the dev sandbox; backend `web` test runs
> may be deferred to the user per the project's test-runner memo.

## 12. Security review checklist (enforced at PR)

- [ ] Token resolves to exactly one user; no client-supplied `userId` is ever trusted.
- [ ] Every project operation passes `AuthorizationManager` for that user, per request.
- [ ] No `privateApiRouter` / internal shared secret anywhere in the MCP request path.
- [ ] No default or ambient token; `OVERLEAF_DEFAULT_TOKEN` removed.
- [ ] Bearer token accepted from the `Authorization` header only.
- [ ] `mcp` scope required and enforced on every `/api/v0/mcp/*` route.
- [ ] `not_found` masks no-access; no project-existence oracle.
- [ ] SSRF guard on `url`-based figure upload; MIME allowlist + size cap.
- [ ] Per-token rate limiting active.
- [ ] Audit log line per request.
- [ ] Feature disabled by default; pure CE unaffected.
- [ ] Isolation acceptance test green before enabling anywhere.

## 13. Work breakdown (for the implementation plan)

1. Remove `worktree-overleaf-mcp-feature`; new worktree from `main`.
2. Extract PAT manager/controller → `Features/PersonalAccessToken/`; add `scopes` to
   create/validate; decouple `/user/personal-access-tokens` routes from `enableGitBridge`.
   Keep git-bridge green.
3. `Settings.enableMcp` + `OVERLEAF_MCP_ENABLED` plumbing (`web`, `server-ce`, compose).
4. `Features/Mcp/` — `McpAuthMiddleware`, `McpAuthorizationMiddleware`, unit tests.
5. `Features/Mcp/McpController` + `McpRouter` — projects & files endpoints, unit tests.
6. Compile endpoints.
7. Figure-upload endpoint + SSRF guard + limits.
8. Account-settings UI: token scope selector + list columns.
9. Rebuild `services/mcp/` on the official SDK: server, Streamable HTTP + stdio transports,
   `OverleafClient`, salvage parsers/schemas.
10. Register authoring-core tools; wire handlers to the new endpoints; `edit_file` and
    semantic tools implemented in-service.
11. `server-ce` runit + nginx; compose service.
12. Acceptance tests incl. the isolation gate; end-to-end run on the dev instance with two
    users.
13. Trim the MCP README to authoring core; document token creation with the `mcp` scope.
