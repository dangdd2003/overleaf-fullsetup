# Overleaf MCP Microservice

## Overview

The Overleaf MCP service (`overleaf/services/mcp/`) is a lightweight, stateless protocol adapter built on the official Model Context Protocol (MCP) TypeScript SDK v2 (`@modelcontextprotocol/server`). It exposes **20 authoring-core tools** for AI assistants (Claude Desktop, Claude Code, Cursor, Windsurf) to interact with Overleaf projects.

The service contains **no authentication logic, no database connection, and no ambient credentials**. Every incoming request must provide an `Authorization: Bearer olp_...` personal access token. The service forwards this token directly to Overleaf's internal REST API (`/api/v0/mcp/*`), where Overleaf's `AuthorizationManager` enforces per-user project access and scope permissions.

## Architecture

```
AI Client (Claude Desktop / Code / Cursor / Windsurf)
       │  MCP Protocol (Streamable HTTP or stdio)
       │  Authorization: Bearer olp_...
       ▼
overleaf-mcp  (:3050 /mcp)
       │  Stateless MCP protocol adapter
       │  20 authoring tools (Zod v4 schemas)
       │  Forwards caller bearer token per request
       ▼  HTTP  Authorization: Bearer olp_...  →  $OVERLEAF_INTERNAL_URL/api/v0/mcp/*
overleaf-web  (compose :3000 / server-ce :4000 — the ENABLED_SERVICES=web role)
       │  requireMcpAuth (validates token, checks 'mcp' scope)
       │  requireMcpProjectRead / requireMcpProjectWrite (AuthorizationManager)
       │  Returns uniform JSON { code, message }
```

## Enabling the MCP Service

The MCP feature is disabled by default. Pure Overleaf Community Edition is completely unaffected unless explicitly enabled.

To enable the service in `docker-compose.yml` or your server environment:

1. Enable the MCP API in `web`:
   ```yaml
   web:
     environment:
       - MCP_ENABLED=true
   ```
2. Enable and start the `mcp` service:
   ```yaml
   mcp:
     environment:
       - MCP_ENABLED=true
       - OVERLEAF_INTERNAL_URL=http://web:3000
   ```
   *(Both services must have `MCP_ENABLED=true` set. Setting it on only one service is non-functional).*

### Which `web` port to point at

`/api/v0/mcp/*` is registered on `publicApiRouter`, which `Server.mjs` mounts
only when `ENABLED_SERVICES` includes `web`. Point `OVERLEAF_INTERNAL_URL` at a
process that runs the *web* role, or every tool call returns a bare `404`
("the Overleaf API returned status 404") even though OAuth completes normally:

- **Standalone `docker-compose`**: the `web` container defaults to
  `ENABLED_SERVICES=web,api`, so `http://web:3000` is correct.
- **All-in-one `server-ce` image**: `web` is split into two processes —
  `web-overleaf` (`ENABLED_SERVICES=web`, port **4000**, what nginx serves at
  `/`) and `web-api-overleaf` (`ENABLED_SERVICES=api`, port **3000**). The MCP
  service must use `http://127.0.0.1:4000`; port 3000 mounts only
  `privateApiRouter` and 404s the whole MCP surface.

## Configuration

The service is configured entirely through environment variables:

| Variable | Default | Description |
|---|---|---|
| `MCP_ENABLED` | `false` | Master switch. If `false`, the service refuses to start. |
| `OVERLEAF_INTERNAL_URL` | *(required if enabled)* | URL to the internal `web` service (e.g. `http://web:3000`). Falls back to `OVERLEAF_SITE_URL`. **On the all-in-one `server-ce` image this must be `http://127.0.0.1:4000`** — see below. |
| `MCP_TRANSPORT` | `http` | Transport mode: `http` (Streamable HTTP) or `stdio` (single-user local CLI). |
| `MCP_HOST` | `127.0.0.1` | Network interface to bind HTTP server to. |
| `MCP_PORT` | `3050` | Port for the HTTP server to listen on. |
| `MCP_ENDPOINT_PATH` | `/mcp` | URL path mounted for Streamable HTTP requests. |
| `MCP_ALLOWED_HOSTS` | `""` | Comma-separated list of allowed `Host` headers. **Required when `MCP_HOST` is bound beyond loopback** (e.g. `0.0.0.0`) to protect against DNS rebinding. |
| `MCP_ALLOWED_ORIGINS` | `""` | Comma-separated list of allowed `Origin` headers. Wildcards (`*`) are rejected. |
| `MCP_MAX_UPLOAD_MB` | `20` | Maximum file upload size in megabytes for `upload_asset`. |
| `MCP_TOKEN` | `""` | Default token used **only** when `MCP_TRANSPORT=stdio` for single-user local debugging. |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`). |

> **Production Note on Public Domains:**
> When serving behind a reverse proxy (e.g., Nginx) under a public domain (e.g., `overleaf.mycompany.com`), Nginx forwards the incoming `Host` header. Ensure `MCP_ALLOWED_HOSTS` includes your domain (e.g., `MCP_ALLOWED_HOSTS=overleaf.mycompany.com,localhost,127.0.0.1`) so the DNS rebinding guard accepts the forwarded host.

## Authentication & Tokens

### Creating a Token

Users generate personal access tokens directly in the Overleaf web interface:
1. Log in to Overleaf.
2. Go to **Account Settings** -> **Personal Access Tokens**.
3. Click **Create Token**.
4. Check the **AI assistant (MCP)** scope (`mcp`).
5. Copy the revealed token (format: `olp_` followed by 32 hexadecimal characters).

Tokens can also be generated programmatically via `POST /user/personal-access-tokens` with body `{"name": "...", "scopes": ["mcp"]}`.

### Token Security
- Tokens are hashed with SHA-256 in the database; raw tokens are never saved or logged.
- Tokens expire after 1 year by default.
- Every tool execution requires a valid token with the `mcp` scope.

## Connecting an AI Client

### Streamable HTTP (Recommended)

Point your AI client to your Overleaf instance's `/mcp` endpoint and pass your token in the `Authorization` header:

#### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "overleaf": {
      "url": "https://your-overleaf-domain.com/mcp",
      "headers": {
        "Authorization": "Bearer olp_your_personal_access_token_here"
      }
    }
  }
}
```

#### Claude Code (`~/.claude/settings.json` or `.mcp.json`)
```json
{
  "mcpServers": {
    "overleaf": {
      "type": "http",
      "url": "https://your-overleaf-domain.com/mcp",
      "headers": {
        "Authorization": "Bearer olp_your_personal_access_token_here"
      }
    }
  }
}
```

#### Cursor / Windsurf
Add a remote MCP server with URL `https://your-overleaf-domain.com/mcp` and HTTP header `Authorization: Bearer olp_...`.

### stdio Transport (Local Development)

To run the MCP server as a local command for debugging:
```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/path/to/overleaf/services/mcp/app.js"],
      "env": {
        "MCP_ENABLED": "true",
        "MCP_TRANSPORT": "stdio",
        "OVERLEAF_INTERNAL_URL": "http://localhost:3000",
        "MCP_TOKEN": "olp_your_personal_access_token_here"
      }
    }
  }
}
```

## Tool Catalog (20 Tools)

The surface is designed with strict `<verb>_<noun>` symmetry, concise tool annotations, and zero redundancy.

### Project Management (5 tools)

| Tool | Description | Target API |
|---|---|---|
| `list_projects` | List user projects | `GET /projects?query=&status=` |
| `create_project` | Create a new project | `POST /projects` |
| `get_project` | Get project details | `GET /projects/:id` |
| `update_project` | Update project settings | `PATCH /projects/:id/settings` |
| `export_project_zip` | Export project as ZIP archive | `GET /projects/:id/zip` or `POST /projects-zip` |

### Files and Documents (8 tools)

| Tool | Description | Target API / Implementation |
|---|---|---|
| `list_files` | List project files | `GET /projects/:id/tree` |
| `search_files` | Search text across project files | `GET /projects/:id/search?query=&path=&fileTypes=&caseSensitive=&maxMatches=` |
| `read_file` | Read file content | `GET /projects/:id/doc?path=&startLine=&endLine=` |
| `write_file` | Create or overwrite file | `POST /projects/:id/doc` |
| `edit_file` | Replace text in file | Reads doc -> in-memory replace -> writes back via `/doc` |
| `move_file` | Move or rename file | `POST /projects/:id/move` |
| `upload_asset` | Upload image or binary asset | `POST /projects/:id/file` |
| `download_file` | Download single file | `GET /projects/:id/file?path=` |

### Compilation and Outputs (4 tools)

| Tool | Description | Target API |
|---|---|---|
| `compile_project` | Compile LaTeX to PDF | `POST /projects/:id/compile` |
| `get_compile_log` | Get compile log | `GET /projects/:id/compile/log?buildId=&maxLines=` |
| `get_compile_pdf` | Download compiled PDF | `GET /projects/:id/compile/pdf?buildId=` |
| `get_word_count` | Get project word count | `GET /projects/:id/wordcount?file=` |

### LaTeX Semantic Tools (3 tools)

| Tool | Description |
|---|---|
| `get_doc_outline` | Get document outline |
| `scan_latex` | Scan LaTeX elements |
| `search_bib` | Search bibliography |

### Prompt Templates (3 Prompts)

Pre-registered workflows that can be triggered directly in MCP clients:

| Prompt | Arguments | Description |
|---|---|---|
| `review_project` | `projectId` | Discovers layout $\to$ extracts outline $\to$ scans citations & references $\to$ checks word count $\to$ test-compiles. |
| `fix_compile_errors` | `projectId`, `buildId?` | Reads build log $\to$ pinpoints error lines $\to$ slices via `read_file` $\to$ applies `edit_file` $\to$ recompiles with `clearCache: true`. |
| `edit_section` | `projectId`, `path`, `title` | Gets outline $\to$ locates start/end lines $\to$ reads section slice $\to$ applies surgical edits $\to$ verifies compile. |

For client-specific setup (Claude Desktop, ChatGPT, Gemini), see [Client Setup Guide](client-setup.md).

### Deliberately not tools

| Endpoint | Why it has no tool |
|---|---|
| `GET /projects/:id/synctex` | Maps between source lines and PDF coordinates. That is an editor-UI primitive: an agent already has line numbers and has no viewport or click position to map from. The REST endpoint remains available to editor-like clients. |

## Error Codes

When a tool fails, the error response carries a structured JSON payload with a `code` and `message`:

| Error Code | HTTP Equivalent | Meaning & AI Assistant Guidance |
|---|---|---|
| `unauthorized` | 401 | Missing, invalid, or expired bearer token. The user must provide a valid `mcp` token. |
| `insufficient_scope` | 403 | The token is valid but lacks the `mcp` scope (e.g. it is a git-only token). |
| `forbidden` | 403 | The user can see the project but lacks permission for this action (e.g., read-only collaborator trying to write or upload). |
| `not_found` | 404 | Project or document does not exist, **or** the user has no access to it. (Overleaf masks non-member projects with 404 to prevent existence discovery). |
| `validation_error` | 400 | Invalid tool arguments (e.g., string not found in `edit_file`, both base64 and URL passed to `upload_asset`). |
| `rate_limited` | 429 | Per-token rate limit exceeded (200 requests / 60 seconds). Back off and retry. |
| `upstream_error` | 502 | A downstream service (CLSI compiler, docstore, document-updater) failed. |

## Limits & Security Guarantees

1. **Per-User Scoping:** A user's token gives access only to projects they own or have been explicitly invited to collaborate on.
2. **Existence Masking:** Requests for unauthorized projects return `404 not_found` identically to non-existent projects, preventing unauthorized users from scanning project IDs.
3. **No Ambient Tokens:** The microservice stores no shared or global tokens; each request forwards the client's token.
4. **Rate Limiting:** Each token is rate-limited to 200 requests per 60 seconds.
5. **SSRF Protection:** When using `upload_asset` with a remote `url`, Overleaf resolves the IP and blocks loopback, private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local, and cloud metadata endpoints (`169.254.169.254`).
6. **Upload Cap:** Files uploaded via base64 or URL are capped at 20 MB (configurable via `MCP_MAX_UPLOAD_MB`).
7. **Document Scanning Cap:** Project-wide semantic scans inspect at most 100 `.tex` documents per tool call (`truncated: true` is returned if more exist) to prevent runaway latency.
