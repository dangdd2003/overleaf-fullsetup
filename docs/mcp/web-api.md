# Overleaf MCP Per-User Web API

## Overview

The Overleaf MCP HTTP API (`/api/v0/mcp/*`) is a per-user REST surface consumed by the MCP microservice and any bearer-token client. Every request is authenticated via a personal access token (`mcp` scoped) and authorized via Overleaf's `AuthorizationManager`, ensuring a token grants exactly the access its owner already has — their own projects and projects shared with them — and nothing instance-wide or belonging to other users. The API returns `404 not_found` for both missing and inaccessible projects (no existence oracle); `403 forbidden` is reserved for when an authenticated user can see a project but lacks the required privilege level (e.g., read-only collaborator hitting a write route). Disabled by default via `MCP_ENABLED=false`.

**Consumed by:** the `mcp` microservice (`overleaf/services/mcp/`) — see [`mcp-service.md`](./mcp-service.md) for the tool surface layered over these endpoints.

## Authentication

### Token Model

Tokens are stored in the `personalAccessTokens` MongoDB collection:

```
{
  user_id: ObjectId,
  name: string,
  tokenHash: string (sha256, unique index),
  tokenPrefix: string (first 8 chars of token),
  scopes: string[] (e.g. ["mcp"], ["git_bridge"], or ["mcp", "git_bridge"]),
  createdAt: Date,
  expiresAt: Date (default +1 year from creation),
  lastUsedAt: Date
}
```

### Token Format

All tokens begin with the prefix `olp_` followed by random characters: `olp_abc123...`

### Creating a Token

Users create tokens via the REST endpoint or Account Settings UI:

**REST endpoint:**
```
POST /user/personal-access-tokens
Content-Type: application/json

{
  "name": "My AI Assistant",
  "scopes": ["mcp"]
}
```

Response: `{ token: "olp_...", tokenPrefix: "olp_...", name: "My AI Assistant", createdAt: "2026-09-04T12:00:00Z", scopes: ["mcp"] }`

The raw `token` is returned only once, at creation time.

**Account Settings UI:**
Navigate to Account Settings → Personal Access Tokens → Create Token, check the "AI assistant (MCP)" scope checkbox, and copy the revealed token.

### Token Expiry & Rate Limit

- **Expiry:** 1 year from creation.
- **Rate Limit:** 200 requests per 60 seconds per token (keyed on `tokenPrefix:userId`), plus a pre-authentication IP-keyed limiter of 60 requests per 60 seconds that runs before token validation to bound amplification from junk tokens.
- **lastUsedAt:** Updated only when > 60 seconds stale to avoid write amplification.

### Bearer Token Header

Tokens are transmitted in the `Authorization` header **only**. Query-string and body fallbacks are deliberately absent.

```
Authorization: Bearer olp_abc123...
```

Missing or invalid tokens return `401 unauthorized`.

## Endpoint Reference

All endpoints are gated by `requireMcpAuth` (authentication) and, if noted, per-project `requireMcpProjectRead` or `requireMcpProjectWrite` (authorization). Every request is rate-limited per token and logged.

| Method | Path | Auth | Query / Body | Response |
|--------|------|------|-----|----------|
| `GET` | `/api/v0/mcp/projects` | auth | `query?: string, status?: string` | `{ projects: [...] }` |
| `POST` | `/api/v0/mcp/projects` | auth | `{ name: string, initialFiles?: [...] }` | `{ project: {...} }` |
| `GET` | `/api/v0/mcp/projects/:projectId` | read | — | `{ project: {...} }` |
| `PATCH` | `/api/v0/mcp/projects/:projectId/settings` | write | `{ compiler?, rootDocId?, spellCheckLanguage? }` | `{ status: "ok" }` |
| `GET` | `/api/v0/mcp/projects/:projectId/tree` | read | — | `{ docs: [...], files: [...] }` |
| `GET` | `/api/v0/mcp/projects/:projectId/search` | read | `query: string, path?: string, fileTypes?: string, caseSensitive?: bool, maxMatches?: int` | `{ query, totalMatches: int, matches: [...] }` |
| `GET` | `/api/v0/mcp/projects/:projectId/doc` | read | `path: string, startLine?: int, endLine?: int` | `{ path, content: string }` |
| `POST` | `/api/v0/mcp/projects/:projectId/doc` | write | `{ path: string, content: string }` | `{ status: "ok", docId: string }` |
| `POST` | `/api/v0/mcp/projects/:projectId/folder` | write | `{ path: string }` | `{ status: "ok" }` |
| `POST` | `/api/v0/mcp/projects/:projectId/move` | write | `{ oldPath: string, newPath: string }` | `{ status: "ok" }` |
| `GET` | `/api/v0/mcp/projects/:projectId/file` | read | `path: string` | streamed binary asset or text content |
| `POST` | `/api/v0/mcp/projects/:projectId/file` | write | `{ path: string, contentBase64?: string, url?: string }` | `{ status: "ok", path, fileId: string }` |
| `GET` | `/api/v0/mcp/projects/:projectId/zip` | read | — | streamed `application/zip` archive |
| `POST` | `/api/v0/mcp/projects-zip` | read | `{ projectIds: string[] }` | streamed `application/zip` bundle of project zips |
| `POST` | `/api/v0/mcp/projects/:projectId/compile` | read | `{ compiler?: string, draft?: bool, stopOnFirstError?: bool }` | `{ status, pdf?: {...}, outputFiles: [...] }` |
| `GET` | `/api/v0/mcp/projects/:projectId/compile/log` | read | `buildId: string, maxLines?: int` | `{ log: string, truncated: bool }` |
| `GET` | `/api/v0/mcp/projects/:projectId/compile/pdf` | read | `buildId: string` | streamed `application/pdf` bytes |
| `POST` | `/api/v0/mcp/projects/:projectId/compile/clear-cache` | write | `clsiserverid?: string` | `{ status: "ok" }` |
| `GET` | `/api/v0/mcp/projects/:projectId/wordcount` | read | `file?: string, clsiserverid?: string` | `{ wordCount: {...} }` |
| `GET` | `/api/v0/mcp/projects/:projectId/synctex` | read | pdf: `page, h, v` OR code: `file, line, column?` | `{ synctex: {...} }` |

### Detailed Endpoint Descriptions

#### `GET /api/v0/mcp/projects`

List all projects owned by or shared with the authenticated user.

**Query parameters:**
- `query` (string, optional): Filter projects by name substring (case-insensitive).
- `status` (string, optional): Filter by project lifecycle status:
  - `"active"` (default): Only active projects (excludes trashed and archived).
  - `"trashed"`: Only projects in the trash.
  - `"archived"`: Only archived projects.
  - `"all"`: All projects regardless of trash or archive status.

**Response:**
```json
{
  "projects": [
    {
      "id": "507f1f77bcf86cd799439011",
      "name": "My Paper",
      "lastUpdated": "2026-09-04T12:00:00Z",
      "compiler": "pdflatex",
      "archived": false,
      "trashed": false
    }
  ]
}
```

**Example:**
```bash
curl -H "Authorization: Bearer olp_abc123..." \
  "http://localhost:3000/api/v0/mcp/projects?query=draft"
```

---

#### `POST /api/v0/mcp/projects`

Create a new project owned by the authenticated user, optionally with initial files.

**Request body:**
```json
{
  "name": "New Project",
  "initialFiles": [
    { "path": "main.tex", "content": "\\documentclass{article}\n..." }
  ]
}
```

**Response:**
```json
{
  "project": {
    "id": "507f1f77bcf86cd799439011",
    "name": "New Project",
    "lastUpdated": "2026-09-04T12:00:00Z",
    "compiler": "pdflatex"
  }
}
```

**Example:**
```bash
curl -X POST -H "Authorization: Bearer olp_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"name":"My Project"}' \
  http://localhost:3000/api/v0/mcp/projects
```

---

#### `GET /api/v0/mcp/projects/:projectId`

Retrieve project metadata including root document and compiler settings.

**Response:**
```json
{
  "project": {
    "id": "507f1f77bcf86cd799439011",
    "name": "My Paper",
    "lastUpdated": "2026-09-04T12:00:00Z",
    "compiler": "pdflatex",
    "rootDocId": "doc123",
    "spellCheckLanguage": "en"
  }
}
```

---

#### `PATCH /api/v0/mcp/projects/:projectId/settings`

Update project settings: compiler, root document, or spell-check language.

**Request body:**
```json
{
  "compiler": "xelatex",
  "rootDocId": "doc456",
  "spellCheckLanguage": "fr"
}
```

At least one field must be provided. Returns `{ status: "ok" }` on success.

---

#### `GET /api/v0/mcp/projects/:projectId/tree`

List all documents and files in the project tree.

**Response:**
```json
{
  "docs": [
    { "path": "/main.tex", "id": "doc123" },
    { "path": "/chapters/intro.tex", "id": "doc456" }
  ],
  "files": [
    { "path": "/figures/logo.png", "id": "file789" }
  ]
}
```

---

#### `GET /api/v0/mcp/projects/:projectId/doc`

Retrieve a document's content by path, with optional line-range slicing.

**Query parameters:**
- `path` (string, required): Document path (e.g., `"/main.tex"`).
- `startLine` (int, optional): Start line (1-indexed); defaults to 1.
- `endLine` (int, optional): End line (1-indexed, inclusive); defaults to end of file.

**Response:**
```json
{
  "path": "/main.tex",
  "content": "\\documentclass{article}\n\\begin{document}\n..."
}
```

**Example:**
```bash
curl -H "Authorization: Bearer olp_abc123..." \
  "http://localhost:3000/api/v0/mcp/projects/507f1f77bcf86cd799439011/doc?path=/main.tex&startLine=1&endLine=50"
```

---

#### `POST /api/v0/mcp/projects/:projectId/doc`

Write or create a document at the given path.

**Request body:**
```json
{
  "path": "/chapters/new-section.tex",
  "content": "\\section{Introduction}\n..."
}
```

**Response:**
```json
{
  "status": "ok",
  "docId": "doc789"
}
```

---

#### `POST /api/v0/mcp/projects/:projectId/folder`

Create a folder (and parent folders if needed).

**Request body:**
```json
{
  "path": "/assets/figures"
}
```

**Response:** `{ status: "ok" }`

---

#### `POST /api/v0/mcp/projects/:projectId/move`

Rename or move a document, file, or folder.

**Request body:**
```json
{
  "oldPath": "/old-name.tex",
  "newPath": "/chapters/renamed.tex"
}
```

**Response:** `{ status: "ok" }`

---

#### `POST /api/v0/mcp/projects/:projectId/file`

Upload a file (figure, asset, etc.) via base64-encoded content or URL fetch.

**Request body (base64):**
```json
{
  "path": "/figures/plot.png",
  "contentBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
}
```

**Request body (URL):**
```json
{
  "path": "/figures/remote.pdf",
  "url": "https://example.com/paper.pdf"
}
```

**Response:**
```json
{
  "status": "ok",
  "path": "/figures/plot.png",
  "fileId": "file123"
}
```

**Constraints:**
- File extension must be in the allowlist (png, jpg, jpeg, pdf, eps, svg, gif, csv, bib, txt).
- File size must not exceed `Settings.mcp.maxUploadBytes` (default 20 MB).
- `contentBase64` has a lower effective ceiling: the JSON body is capped by
  `Settings.max_json_request_size` (~12 MB) and base64 inflates payloads by 4/3,
  so `contentBase64` is limited to ~70% of `max_json_request_size` (~8 MB of
  encoded text). Oversize base64 returns `validation_error`. Use the `url`
  option for anything larger — it is only bounded by `Settings.mcp.maxUploadBytes`.
- URL fetches include SSRF protection: private/loopback/link-local/metadata ranges are rejected, redirects and download size are capped, and requests time out after a few seconds.

**Example:**
```bash
curl -X POST -H "Authorization: Bearer olp_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"path":"/figures/logo.png","contentBase64":"..."}' \
  http://localhost:3000/api/v0/mcp/projects/507f1f77bcf86cd799439011/file
```

---

#### `POST /api/v0/mcp/projects/:projectId/compile`

Trigger a LaTeX compilation of the project.

**Request body:**
```json
{
  "compiler": "pdflatex",
  "draft": false,
  "stopOnFirstError": true
}
```

All fields are optional; the project's defaults are used if omitted.

**Response:**
```json
{
  "status": "success",
  "pdf": {
    "build": "buildId123",
    "path": "output.pdf"
  },
  "outputFiles": [
    { "path": "output.pdf", "build": "buildId123" },
    { "path": "output.log", "build": "buildId123" }
  ]
}
```

Status values: `success`, `failure`, `clsi-unavailable`, `project-too-large`, `too-many-runs`, `request-timeout`.

---

#### `GET /api/v0/mcp/projects/:projectId/compile/log`

Retrieve the compilation log (bounded to avoid buffering multi-MB logs).

**Query parameters:**
- `buildId` (string, required): The build identifier from a compile response.
- `maxLines` (int, optional): Maximum lines to return (capped at 10000); defaults to 1000.

**Response:**
```json
{
  "log": "This is pdfTeX...\n[1] ...",
  "truncated": false
}
```

If `truncated: true`, the log was larger than `maxLines` and only the last `maxLines` lines are included.

---

#### `GET /api/v0/mcp/projects/:projectId/compile/pdf`

Stream the compiled PDF bytes back through the MCP route itself (bearer clients
cannot follow a session-authenticated `webRouter` URL). The response body is the
raw PDF with `Content-Type: application/pdf`.

**Query parameters:**
- `buildId` (string, required): The build identifier. Malformed values return
  `validation_error`. A missing `buildId` also returns `validation_error` (this
  endpoint does not compile on demand).

**Response:** `200` with the PDF bytes, or `404 not_found` if that build has no
`output.pdf`.

---

#### `POST /api/v0/mcp/projects/:projectId/compile/clear-cache`

Clear compilation cache and auxiliary files (`.aux`, `.fls`, etc.).

**Query parameters:**
- `clsiserverid` (string, optional): Target CLSI server; usually not needed.

**Response:** `{ status: "ok" }`

---

#### `GET /api/v0/mcp/projects/:projectId/wordcount`

Count words in the LaTeX project.

**Query parameters:**
- `file` (string, optional): Count only a specific file; if omitted, count the entire project.
- `clsiserverid` (string, optional): Target CLSI server.

**Response:**
```json
{
  "wordCount": {
    "words": 1234,
    "headers": 10,
    "body": 1200,
    "captions": 24
  }
}
```

---

#### `GET /api/v0/mcp/projects/:projectId/synctex`

Perform a SyncTeX forward (code → PDF) or inverse (PDF → code) lookup.

**Query parameters (forward, code → PDF):**
- `file` (string): Source filename (e.g., `"main.tex"`).
- `line` (int): Source line number.
- `column` (int, optional): Source column number.
- `buildId` (string, optional): Specific build to query.

**Query parameters (inverse, PDF → code):**
- `page` (int): PDF page number.
- `h` (number): Horizontal position in PDF coordinates.
- `v` (number): Vertical position in PDF coordinates.
- `buildId` (string, optional): Specific build to query.

**Response:**
```json
{
  "synctex": [
    { "file": "main.tex", "line": 42, "column": 5 }
  ]
}
```

---

## Error Envelope

All errors are returned as JSON with a `code` and `message`:

```json
{
  "code": "not_found",
  "message": "not found"
}
```

### Error Codes & HTTP Status

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `unauthorized` | 401 | Missing, invalid, malformed, or expired bearer token. |
| `insufficient_scope` | 403 | Bearer token is valid but lacks the `mcp` scope. |
| `forbidden` | 403 | User is authenticated and can see the project, but lacks the required privilege (e.g., read-only collaborator hitting a write route). |
| `not_found` | 404 | Project or document does not exist **or** the user has no access to it. **No distinction is made** to prevent project-existence leaks. |
| `validation_error` | 400 | Bad or malformed request parameters (e.g., missing required fields). |
| `rate_limited` | 429 | Per-token rate limit exceeded (200 req / 60s). |
| `upstream_error` | 502 | A downstream service (CLSI, docstore, document-updater, etc.) failed or is unavailable. |

## Enabling the API

### Configuration

Set `MCP_ENABLED=true` on the `web` service in `docker-compose.yml` or your deployment:

```yaml
web:
  environment:
    MCP_ENABLED: 'true'
```

This enables:
1. The `/api/v0/mcp/*` endpoint routes in `McpRouter`.
2. The `POST /user/personal-access-tokens` endpoint for token creation (shared with git-bridge tokens).
3. The MCP scope selector in Account Settings.

### Feature Flag Behavior

- **Default:** `MCP_ENABLED=false` (pure Overleaf CE is unaffected).
- **When disabled:** `McpRouter.apply()` returns early; no routes are registered.
- **When enabled on a multi-user instance:** The isolation acceptance test (`test/acceptance/src/McpTests.mjs`) **must pass** before enabling in production to confirm cross-user authorization is correctly enforced.

### Acceptance Gate

Before enabling on a multi-user instance, run:

```bash
npm test -- test/acceptance/src/McpTests.mjs
```

This test confirms:
- User B's token cannot access user A's projects (returns `404 not_found`).
- User B as a read-only collaborator can `GET` but not `POST` (returns `403 forbidden` on write).
- A `git_bridge`-only token is rejected on `/api/v0/mcp/*` routes (returns `403 insufficient_scope`).
- An `mcp` token is rejected on git-bridge routes (scope isolation).

## Notes

- **Token Security:** Tokens are hashed with SHA-256 before storage; the hash is indexed for fast validation. The raw token is never logged.
- **Cross-Tenant Isolation:** Every project operation is authorized via `AuthorizationManager`, ensuring per-user scoping even in a shared instance.
- **Audit Logging:** Every successful request logs `{ mcpUserId, mcpTokenPrefix, route, status }` at info level for audit trails.
- **Semantic Tools:** Tools like `edit_file`, LaTeX outline parsing, citation management, and figure detection are implemented in the MCP microservice and operate on documents fetched via `GET .../doc` and `GET .../tree`; no new endpoints are needed.

