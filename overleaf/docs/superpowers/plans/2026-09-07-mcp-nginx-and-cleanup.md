# MCP Nginx Proxy & Dead Code Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route RFC 9728 Protected Resource Metadata queries through the Nginx reverse proxy to the Overleaf MCP service, and remove unused Mongoose models/schemas from `services/web/app/src/infrastructure/mongodb.mjs`.

**Architecture:** Two independent tasks. Task 1 adds a `location /.well-known/oauth-protected-resource` proxy directive to `mcp.conf.template` so Nginx routes RFC 9728 discovery requests to the MCP service running on `${MCP_HOST}:${MCP_PORT}`. Task 2 strips dead Mongoose schemas and model definitions from `mongodb.mjs`, as Google Drive sync communicates exclusively through native driver handles.

**Tech Stack:** Nginx configuration templating (`envsubst`), Node.js ESM, MongoDB native driver, Mocha/Vitest.

**Spec:** Classified as a bounded task during brainstorming; design documented in chat.

## Global Constraints

- Do not modify `overleaf/server-ce/init_scripts/200_nginx_config_template.sh`. It already exports and substitutes `${MCP_HOST}` and `${MCP_PORT}`.
- Do not remove `import Mongoose from './Mongoose.mjs'` in `mongodb.mjs`, as line 13 asserts `Mongoose.mongo.ObjectId === mongodb.ObjectId`.
- Commit messages: short, clean, no `Co-Authored-By` trailer, matching project history (e.g. `fix(mcp): proxy rfc9728 metadata in nginx` and `chore(web): remove unused mongoose schemas in mongodb.mjs`).
- Never execute git commits or branch operations without explicit owner confirmation.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `overleaf/server-ce/nginx/mcp.conf.template` | Modify | Adds `location /.well-known/oauth-protected-resource` proxy block. |
| `overleaf/services/web/app/src/infrastructure/mongodb.mjs` | Modify | Removes dead Mongoose schemas, models, and export default keys. |

---

### Task 1: Proxy RFC 9728 Protected Resource Metadata in Nginx

**Files:**
- Modify: `overleaf/server-ce/nginx/mcp.conf.template:18-20`

**Interfaces:**
- Consumes: `${MCP_HOST}`, `${MCP_PORT}` substituted by `200_nginx_config_template.sh`.
- Produces: Proxied endpoint at `/.well-known/oauth-protected-resource` directing to `http://${MCP_HOST}:${MCP_PORT}`.

- [ ] **Step 1: Inspect current `mcp.conf.template`**

Run:
```bash
cat overleaf/server-ce/nginx/mcp.conf.template
```

- [ ] **Step 2: Append RFC 9728 location block to `mcp.conf.template`**

Edit `overleaf/server-ce/nginx/mcp.conf.template` to append:
```nginx

# RFC 9728 OAuth 2.0 Protected Resource Metadata
location /.well-known/oauth-protected-resource {
	proxy_pass http://${MCP_HOST}:${MCP_PORT};
	proxy_http_version 1.1;

	proxy_set_header Host $host;
	proxy_set_header X-Forwarded-Host $host;
	proxy_set_header X-Forwarded-Proto $scheme;
	proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

- [ ] **Step 3: Verify template variable substitution**

Run:
```bash
MCP_HOST="127.0.0.1" MCP_PORT="3050" envsubst '${MCP_HOST} ${MCP_PORT}' < overleaf/server-ce/nginx/mcp.conf.template > /tmp/test-mcp.conf
grep -A 8 "location /.well-known/oauth-protected-resource" /tmp/test-mcp.conf
```
Expected output contains:
```nginx
location /.well-known/oauth-protected-resource {
	proxy_pass http://127.0.0.1:3050;
	proxy_http_version 1.1;
```

- [ ] **Step 4: Request user confirmation before commit**

Ask: *"Task 1 verified. Confirm committing with message `fix(nginx): proxy rfc9728 protected resource metadata to mcp`?"*

---

### Task 2: Remove Dead Mongoose Schemas & Models from `mongodb.mjs`

**Files:**
- Modify: `overleaf/services/web/app/src/infrastructure/mongodb.mjs:126-193`

**Interfaces:**
- Consumes: Native Mongo driver handles `db.googleDriveUserCredentials` and `db.googleDriveProjectStates` (retained).
- Produces: Cleaned module exports without dead Mongoose models.

- [ ] **Step 1: Check for any dangling references across repository**

Run:
```bash
git grep -E "GoogleDriveUserCredentials|GoogleDriveProjectStates" overleaf/
```
Expected: Matches only within `overleaf/services/web/app/src/infrastructure/mongodb.mjs`.

- [ ] **Step 2: Remove dead code from `mongodb.mjs`**

In `overleaf/services/web/app/src/infrastructure/mongodb.mjs`:
1. Remove lines 127–184:
   - `const { Schema } = Mongoose`
   - `export const GoogleDriveUserCredentialsSchema = ...`
   - `export const GoogleDriveProjectStatesSchema = ...`
   - `export const GoogleDriveUserCredentials = ...`
   - `export const GoogleDriveProjectStates = ...`
2. Remove from `export default { ... }`:
   - `GoogleDriveUserCredentialsSchema,`
   - `GoogleDriveProjectStatesSchema,`
   - `GoogleDriveUserCredentials,`
   - `GoogleDriveProjectStates,`

- [ ] **Step 3: Verify module syntax and importability**

Run:
```bash
node --check overleaf/services/web/app/src/infrastructure/mongodb.mjs
```
Expected: Clean exit (code 0).

- [ ] **Step 4: Request user confirmation before commit**

Ask: *"Task 2 verified. Confirm committing with message `chore(web): remove unused google drive mongoose models`?"*
