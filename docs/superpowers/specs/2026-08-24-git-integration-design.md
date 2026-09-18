# Design Specification: Native Git Integration for Overleaf Community Edition

**Date**: 2026-08-24  
**Status**: Draft / Under Review  
**Target**: Overleaf Community Edition (Server CE)

---

## 1. Overview & Goals

Overleaf provides direct Git integration allowing users to clone, edit, push, and pull Overleaf LaTeX projects using standard Git clients via HTTP:
```bash
git clone https://<overleaf-host>/git/<project_id>
```

While the core Java Git service (`services/git-bridge`) exists in the repository, it is currently not operational in Community Edition (CE) because the backend Snapshot APIs (`/api/v0/docs/...`), token authentication endpoints (`/oauth/token/info`), and frontend UI dialogs were historically part of proprietary Server Pro modules.

### Primary Goals
1. Implement the missing **Personal Access Token (PAT)** management and validation endpoints in `services/web`.
2. Implement the **Snapshot API adapter** (`/api/v0/docs/...`) in `services/web` to bridge `git-bridge` with Overleaf's document store (`docstore`, `filestore`, `document-updater`, and `project-history`).
3. Add the **Frontend UI components**: the "Clone with Git" modal in the IDE left sidebar rail (`IntegrationsPanel`) and the Git token management section in User Account Settings (`/user/settings`).
4. Enable and orchestrate the `services/git-bridge` container in Community Edition Docker Compose configurations with reverse proxy routing under `/git/*`.
5. Pass the existing end-to-end Cypress acceptance tests in `server-ce/test/git-bridge.spec.ts`.

---

## 2. System Architecture

```
+-----------------------------------------------------------------------------------+
| User Git Client (CLI / IDE)                                                      |
|   `git clone / pull / push https://<host>/git/<project_id>`                        |
+-----------------------------------------------------------------------------------+
                                         |
                                         | HTTP Basic Auth (user: `git`, pass: `olp_...`)
                                         v
+-----------------------------------------------------------------------------------+
| Reverse Proxy (Nginx / Gateway)                                                   |
|   Route `/git/*` -> `http://git-bridge:8000/`                                     |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| Git Bridge Service (`services/git-bridge` - Java / Jetty / JGit)                   |
|   - Handles Git Smart HTTP packfile negotiation & caching                         |
|   - Authenticates via Oauth2Filter                                                |
|   - Calls Web Snapshot API for doc versions & push postbacks                      |
+-----------------------------------------------------------------------------------+
          |                                                   |
          | 1. GET /oauth/token/info                          | 2. Snapshot API (/api/v0/docs/...)
          v                                                   v
+-----------------------------------------------------------------------------------+
| Overleaf Web Service (`services/web` - Node.js Express)                           |
|                                                                                   |
|  [PersonalAccessTokenManager]            [SnapshotApiController]                  |
|    - Validates token hash                  - GET /api/v0/docs/:projectId          |
|    - Resolves user & permissions           - GET /api/v0/docs/:projectId/saved_vers|
|                                            - GET /api/v0/docs/:id/snapshots/:ver  |
|                                            - POST /api/v0/docs/:id/snapshots      |
+-----------------------------------------------------------------------------------+
          |                                                   |
          v                                                   v
+-----------------------------+          +------------------------------------------+
| MongoDB                     |          | Internal Services                        |
|   - `personalAccessTokens`  |          |   - `docstore` (text doc content)        |
|   - `users`, `projects`     |          |   - `filestore` (binary attachments)     |
|                             |          |   - `document-updater` (real-time sync)  |
|                             |          |   - `project-history` / `history-v1`     |
+-----------------------------+          +------------------------------------------+
```

---

## 3. Subsystem 1: Personal Access Tokens & Authentication

### 3.1 MongoDB Data Model (`PersonalAccessToken`)
A new Mongoose model `PersonalAccessToken` (or reusing `OauthAccessToken` schema) in `services/web/app/src/models/PersonalAccessToken.mjs`:

```javascript
import mongoose from '../infrastructure/Mongoose.mjs'
const { Schema } = mongoose

export const PersonalAccessTokenSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, default: 'Git Token' },
    tokenHash: { type: String, required: true, unique: true, index: true },
    tokenPrefix: { type: String, required: true }, // e.g. "olp_1234"
    scopes: { type: [String], default: ['git_bridge'] },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date },
    expiresAt: { type: Date }
  },
  { collection: 'personalAccessTokens' }
)

export const PersonalAccessToken = mongoose.model(
  'PersonalAccessToken',
  PersonalAccessTokenSchema
)
```

### 3.2 Token Lifecycle APIs
1. **Create Token**: `POST /user/personal-access-tokens`
   - Authenticated via standard web session.
   - Generates a crypto-secure token with format `olp_<32_random_hex_or_alphanumeric>`.
   - Computes SHA-256 hash `tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')`.
   - Saves record with `tokenPrefix = rawToken.slice(0, 8)`.
   - Returns `{ token: rawToken, tokenPrefix, name, createdAt }` (raw token displayed to user once).

2. **List Tokens**: `GET /user/personal-access-tokens`
   - Returns array of tokens for current user without plain token secret:
     `[{ _id, name, tokenPrefix, createdAt, lastUsedAt, expiresAt }]`.

3. **Revoke Token**: `DELETE /user/personal-access-tokens/:tokenId`
   - Removes the token document from MongoDB.

### 3.3 Token Verification Endpoint: `GET /oauth/token/info`
Called by `git-bridge` (`Oauth2Filter`):
- Receives header `Authorization: Bearer <token>` or Basic auth `git:<token>`.
- Hashes `<token>` and finds active document in `personalAccessTokens`.
- Updates `lastUsedAt = new Date()`.
- Responds with:
  ```json
  {
    "user_id": "60f1b4a9e1b2c3d4e5f6g7h8",
    "email": "user@example.com",
    "scope": ["git_bridge"]
  }
  ```
- If token is missing, revoked, or expired: returns HTTP 401 `{ "error": "invalid_token", "error_description": "The access token provided is invalid or expired." }`.

---

## 4. Subsystem 2: Snapshot API & Synchronization

Endpoints are registered in `services/web/app/src/Features/GitBridge/GitBridgeApiController.mjs` mounted under `/api/v0/docs`.

### 4.1 `GET /api/v0/docs/:projectId` (Project Metadata)
- **Purpose**: Checks if project exists and retrieves latest version ID and author info.
- **Access Check**: Verifies token user has at least read permissions on `projectId`.
- **Response**:
  ```json
  {
    "latestVerId": 12,
    "latestVerAt": "2026-08-24T10:15:30.000Z",
    "latestVerBy": {
      "email": "editor@example.com",
      "name": "Editor Name"
    }
  }
  ```
- **Error Response**: HTTP 404 `{ "code": "invalidProject", "message": "Project not found" }` if project does not exist or user lacks permission.

### 4.2 `GET /api/v0/docs/:projectId/saved_vers` (Version History)
- **Purpose**: Returns revision history list used by `git-bridge` to construct Git commit history.
- **Response**:
  ```json
  [
    {
      "versionId": 12,
      "comment": "Update abstract and main",
      "user": {
        "email": "editor@example.com",
        "name": "Editor Name"
      },
      "createdAt": "2026-08-24T10:15:30.000Z"
    }
  ]
  ```

### 4.3 `GET /api/v0/docs/:projectId/snapshots/:versionId` (Project Files)
- **Purpose**: Supplies the complete document tree for a given version.
- **Structure**:
  - Traverses `ProjectRootFolder` (folders, docs, files).
  - **`srcs`**: Array of `[contentString, relativePath]` for text files (`.tex`, `.bib`, `.sty`, etc.) fetched from `docstore`.
  - **`atts`**: Array of `[downloadUrl, relativePath]` for binary attachments (images, PDFs) pointing to `filestore` download endpoints.
- **Response**:
  ```json
  {
    "srcs": [
      ["\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}", "main.tex"]
    ],
    "atts": [
      ["http://sharelatex:3000/project/60f1b.../file/60f1b.../download", "images/logo.png"]
    ]
  }
  ```

### 4.4 `POST /api/v0/docs/:projectId/snapshots` (Ingest Git Push)
- **Purpose**: Ingests new commits pushed by the user via `git push`.
- **Request Body**:
  ```json
  {
    "latestVerId": 12,
    "files": [
      {
        "name": "main.tex",
        "url": "http://git-bridge:8000/api/projects/60f1b.../raw/main.tex"
      },
      {
        "name": "old_file.tex"
      }
    ],
    "postbackUrl": "http://git-bridge:8000/api/projects/60f1b.../postback/abc123key"
  }
  ```
- **Execution Flow**:
  1. **Permission Check**: Verifies authenticated user has read-write (collaborator/owner) permissions. If read-only: returns HTTP 403 Forbidden.
  2. **Version Check**: Compares `latestVerId` against current project version. If out of sync: returns HTTP 409 Conflict `{ "code": "outOfDate" }`.
  3. **Acknowledge Request**: Returns HTTP 202 `{ "code": "accepted" }`.
  4. **Fetch & Apply Diffs**:
     - Downloads modified files from `git-bridge` raw URLs.
     - Compares incoming files against current project structure.
     - Creates new files, updates document lines via `DocumentUpdaterHandler` / `ProjectEntityHandler`, and deletes removed files.
     - Stamps history update with `origin: 'git-bridge'` and Git commit author details.
     - Broadcasts updates to connected web editor clients via WebSockets.
  5. **Trigger Postback**:
     - Sends HTTP POST to `postbackUrl`:
       ```json
       {
         "code": "upToDate",
         "latestVerId": 13
       }
       ```
     - `git-bridge` receives postback, releases lock, and completes client's `git push`.

---

## 5. Subsystem 3: Frontend UI Components

### 5.1 IDE Left Sidebar Rail (`IntegrationsPanel`)
- File: `services/web/frontend/js/features/integrations-panel/integrations-panel.tsx`
- When `gitBridgeEnabled` is true, the **Integrations** tab appears in `rail.tsx`.
- The panel renders the **Git** integration card:
  - Label: **"Git"**
  - Description: *"Git clone this project."*
  - Icon: Git logo.
  - Clicking triggers `activeModal = 'git-bridge'` in `useRailContext()`.

### 5.2 "Clone with Git" Modal (`GitBridgeModal`)
- File: `services/web/frontend/js/features/ide-react/components/modals/git-bridge-modal.tsx`
- Dialog features:
  - Data attribute: `data-testid="git-bridge-modal"`.
  - Header: **"Clone with Git"**.
  - Clone command input with copy button: `git clone https://<host>/git/<projectId>`.
  - Credentials guide: Username `git`, Password: Git Personal Access Token.
  - **"Generate token"** button (generates a token directly via `POST /user/personal-access-tokens` and displays it in a copy box).
  - Link to `/user/settings` for full token management.

### 5.3 User Account Settings Widget (`GitTokensSettingsWidget`)
- File: `services/web/frontend/js/features/settings/components/linking/git-tokens-widget.tsx`
- Integrated into `services/web/frontend/js/features/settings/components/linking-section.tsx`.
- Table showing all active tokens with creation date, last used date, and **Delete / Revoke** action button.
- **"Add another token"** action opening the generation dialog.

---

## 6. Subsystem 4: Docker & Deployment Configuration

### 6.1 `services/git-bridge` Docker Image
- Standard Dockerfile in `services/git-bridge/Dockerfile` builds Java JAR with dependencies.
- Runs with `server-pro-start.sh` or `start.sh` on port `8000`.

### 6.2 Docker Compose Configuration
```yaml
services:
  sharelatex:
    environment:
      GIT_BRIDGE_ENABLED: "true"
      GIT_BRIDGE_HOST: "git-bridge"
      GIT_BRIDGE_PORT: "8000"

  git-bridge:
    build:
      context: .
      dockerfile: services/git-bridge/Dockerfile
    environment:
      GIT_BRIDGE_API_BASE_URL: "http://sharelatex:3000/api/v0/"
      GIT_BRIDGE_OAUTH2_SERVER: "http://sharelatex:3000"
      GIT_BRIDGE_POSTBACK_BASE_URL: "http://git-bridge:8000"
      GIT_BRIDGE_ROOT_DIR: "/data/git-bridge"
    volumes:
      - git-bridge-data:/data/git-bridge
    depends_on:
      - sharelatex
    restart: always

volumes:
  git-bridge-data:
```

### 6.3 Nginx Reverse Proxy Route
```nginx
location /git/ {
    proxy_pass http://git-bridge:8000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 500M;
}
```

---

## 7. Error Handling & Edge Cases

| Scenario | Behavior / Response |
| :--- | :--- |
| **Invalid / Revoked Token** | HTTP 401 on `/oauth/token/info`; Git client receives `fatal: Authentication failed`. |
| **Read-Only Collaborator Pushing** | HTTP 403 on `POST /api/v0/docs/:projectId/snapshots`; Git client receives rejection with permission error. |
| **Out-of-Date Push (Concurrent Edits)** | HTTP 409 Conflict on `/snapshots`; `git-bridge` rejects push; Git client prompts user to `git pull` before pushing. |
| **Large Files / Quota Exceeded** | Git Bridge enforces `maxFileSize` (50MB) and returns clear rejection message to client. |
| **Link Sharing Project ID** | `Oauth2Filter` detects link sharing IDs and provides instructive message explaining direct project ID is required. |

---

## 8. Verification & Test Plan

1. **Unit Tests**:
   - `PersonalAccessTokenManager`: Token creation, SHA-256 hashing, prefix generation, validation, and revocation.
   - `GitBridgeApiController`: Test `/api/v0/docs/:projectId` metadata, version listing, snapshot serialization (`srcs`/`atts`), push acceptance, and postback execution.
2. **Integration Tests**:
   - `services/git-bridge`: Run `mvn test` and `WLGitBridgeIntegrationTest`.
3. **End-to-End Acceptance Tests**:
   - Run `server-ce/test/git-bridge.spec.ts` via Cypress:
     - Token generation in Account Settings.
     - "Clone with Git" modal in Editor Rail.
     - Full `git clone`, `git commit`, `git push`, and `git pull` verification.
     - Real-time WebSocket sync and `(via Git)` history badge verification.
     - Read-only vs read-write collaborator permissions enforcement.
