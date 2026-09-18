# AI Assist Security Hardening Design Specification

**Date:** 2026-09-15  
**Topic:** AI Assist Security Hardening & Strict Project Isolation  
**Status:** Approved  

---

## 1. Goal & Threat Model

### 1.1 Goal
Confine all Overleaf AI Assist operations strictly to the single active project and the authenticated user's session. Prevent cross-project data leakage, unauthorized run tampering, Server-Side Request Forgery (SSRF) into internal Docker infrastructure, identity spoofing, and path traversal.

### 1.2 Threat Model & Boundaries

1. **Cross-Project Run Access (IDOR / BOLA)**:
   * *Threat*: An authenticated user accesses `/ai-assist/runs/:runId/stream`, `/stop`, or `/approve` for a run belonging to a project they do not have permissions on.
   * *Mitigation*: Mount run endpoints under `/ai-assist/projects/:Project_id/runs/:runId/*` protected by Overleaf's standard project authorization middleware (`ensureUserCanReadProjectContent` / `ensureUserCanWriteProjectContent`), and cross-check `run.projectId === req.params.Project_id`.

2. **Server-Side Request Forgery (SSRF)**:
   * *Threat*: An attacker supplies a malicious `providerSettings.baseUrl` in `createRun` that targets internal Docker services (`mongo:27017`, `redis:6379`, `clsi:3013`, `filestore:3009`, `document-updater:3003`) or cloud metadata (`169.254.169.254`).
   * *Mitigation*: Validate `providerSettings.baseUrl` before instantiating clients. Disallow internal container hostnames, loopbacks, link-local metadata, and container subnets. Allow only valid public endpoints or the designated host bridge gateway (`DOCKER_HOST_GATEWAY`) for local Ollama.

3. **User Identity Attribution & Setting Spoofing**:
   * *Threat*: Missing or unverified `userId` in `_resolveValidUserId` defaults to `project.owner_ref`, attributing collaborator edits to the owner or mutating the owner's personal editor preferences.
   * *Mitigation*: Strictly require a valid 24-character hexadecimal ObjectId `userId`. If missing, reject the action immediately; never fall back to `owner_ref`.

4. **Run Identifier Guessing**:
   * *Threat*: 32-bit random hex (`crypto.randomBytes(4)`) combined with a millisecond timestamp is vulnerable to enumeration.
   * *Mitigation*: Upgrade to `crypto.randomBytes(16)` (128 bits of cryptographic entropy).

5. **Path Traversal Escape**:
   * *Threat*: File operations (`read_file`, `edit_file`, `create_file`) provide paths containing `../` to access files outside the project root.
   * *Mitigation*: Normalize all paths via POSIX resolution and reject any path resolving outside the root or containing `..`.

---

## 2. Architecture & Components

```
+-----------------------------------------------------------------------------------+
|                                  WEB BROWSER                                      |
|  +-----------------------------------------------------------------------------+  |
|  |  background-run-client.ts                                                   |  |
|  |  - Requests: /ai-assist/projects/:projectId/runs/:runId/(stream|stop|approve) |
|  +---------------------------------------+-------------------------------------+  |
+------------------------------------------|----------------------------------------+
                                           | HTTP Requests
                                           v
+-----------------------------------------------------------------------------------+
|                        OVERLEAF WEB (ROUTING & AUTH)                              |
|  +-----------------------------------------------------------------------------+  |
|  |  AiAssistRunRouter.mjs                                                      |  |
|  |  - POST /ai-assist/projects/:Project_id/runs -> ensureUserCanWrite          |  |
|  |  - GET  /ai-assist/projects/:Project_id/runs/:runId/stream -> ensureUserCanRead|  
|  |  - POST /ai-assist/projects/:Project_id/runs/:runId/stop -> ensureUserCanWrite|  
|  |  - POST /ai-assist/projects/:Project_id/runs/:runId/approve -> ensureUserCanWrite|
|  +---------------------------------------+-------------------------------------+  |
|                                          v                                        |
|  +-----------------------------------------------------------------------------+  |
|  |  AiAssistRunController.mjs                                                  |  |
|  |  - Validate safe baseUrl (SSRF check)                                       |  |
|  |  - 128-bit runId generation                                                 |  |
|  |  - Cross-assert: run.projectId === req.params.Project_id                     |  |
|  |  - Legacy route fallback auth check                                         |  |
|  +---------------------------------------+-------------------------------------+  |
|                                          v                                        |
|  +-----------------------------------------------------------------------------+  |
|  |  AiAssistTools.mjs                                                          |  |
|  |  - Strict userId check (no owner fallback)                                  |  |
|  |  - Path normalization & traversal rejection                                 |  |
|  |  - Isolated compile cache                                                   |  |
|  +---------------------------------------+-------------------------------------+  |
|                                          v                                        |
|  +-----------------------------------------------------------------------------+  |
|  |  AiAssistProviders.mjs (validateSafeProviderBaseUrl)                        |  |
|  |  - Block internal Docker hostnames & 169.254.169.254                        |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

## 3. Detailed Component Specifications

### 3.1 Routing & Authorization (`AiAssistRunRouter.mjs`)
Update route registrations:
* Mount all run operations under `/ai-assist/projects/:Project_id/runs...`:
  ```javascript
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
  ```
* Retain legacy routes (`/ai-assist/runs/:runId/stream`, `/stop`, `/approve`) with inline fallback authorization in `AiAssistRunController` to prevent breaking in-flight runs while guaranteeing no unauthorized access.

### 3.2 Run Controller & Entropy (`AiAssistRunController.mjs`)
1. **Run ID Generation**:
   ```javascript
   const runId = `run_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`
   ```
2. **Project Cross-Assertion**:
   In `streamRun`, `stopRun`, `approve`:
   ```javascript
   const run = await this.store.getRun(runId)
   if (!run) return res.status(404).json({ error: 'Run not found' })

   const projectId = req.params.Project_id || req.params.project_id
   if (projectId && run.projectId !== projectId) {
     return res.status(403).json({ error: 'Cross-project run access forbidden' })
   }

   // For legacy routes lacking Project_id parameter:
   if (!projectId) {
     const loggedInUserId = SessionManager.getLoggedInUserId(req.session)
     const canAccess = await AuthorizationManager.promises.canUserReadProject(loggedInUserId, run.projectId)
     if (!canAccess) return res.status(403).json({ error: 'Forbidden' })
   }
   ```
3. **Early SSRF Validation in `createRun`**:
   Before initializing `manager.startRun`, run `validateSafeProviderBaseUrl(providerSettings.baseUrl)`:
   If validation fails, immediately respond with `res.status(400).json({ error: 'Invalid or restricted provider URL' })`.

### 3.3 SSRF Defense Utility (`AiAssistProviders.mjs`)
Export `validateSafeProviderBaseUrl(rawUrl)`:
* Parse URL using `new URL(rawUrl)`.
* Protocol must be `http:` or `https:`.
* Denylist internal container names:
  ```javascript
  const BLOCKED_HOSTNAMES = new Set([
    'mongo', 'mongodb', 'redis', 'clsi', 'docstore', 'document-updater',
    'filestore', 'chat', 'real-time', 'spelling', 'contacts', 'notifications',
    'git-bridge', 'project-history', 'metadata.google.internal', 'localhost'
  ])
  ```
  *(Note: localhost is mapped to `DOCKER_HOST_GATEWAY` if Docker is active; if unmapped, blocked)*.
* Deny cloud metadata: `169.254.169.254` and `169.254.0.0/16`.
* Deny loopback `127.0.0.1` and `::1`.
* Allow designated `DOCKER_HOST_GATEWAY` (e.g. `172.20.0.1`) to enable local Ollama instances on the Docker host, but block other container IPs.

### 3.4 Tool Identity & Path Sanitization (`AiAssistTools.mjs`)
1. **User Identity Resolution**:
   ```javascript
   async _resolveValidUserId(projectId, rawUserId) {
     if (rawUserId && /^[0-9a-f]{24}$/i.test(String(rawUserId))) {
       return String(rawUserId)
     }
     throw new Error('Valid user identity is required to execute project actions')
   }
   ```
2. **Path Sanitization**:
   ```javascript
   _sanitizePath(rawPath) {
     if (!rawPath || typeof rawPath !== 'string') {
       throw new Error('Path is required')
     }
     const normalized = path.posix.normalize(rawPath).replace(/^\/+/, '')
     if (normalized.startsWith('..') || normalized.includes('/../')) {
       throw new Error('Path traversal forbidden')
     }
     return normalized
   }
   ```
3. **Compile Cache Scope**:
   Store compile results keyed by `projectId`, and clear old results upon project close or run termination.

### 3.5 Frontend Client Synchronization (`background-run-client.ts`)
Update event source URL and action endpoints:
```typescript
const url = `/ai-assist/projects/${projectId}/runs/${runId}/stream?since=${since}`
```
Pass `projectId` when sending stop and approve commands.

---

## 4. Testing Strategy

1. **Unit Tests**:
   * Test `validateSafeProviderBaseUrl`:
     * Asserts rejection on `http://mongo:27017`, `http://redis:6379`, `http://169.254.169.254`, `file:///etc/passwd`.
     * Asserts acceptance on `https://api.openai.com`, `https://api.anthropic.com`, `http://172.20.0.1:11434`.
   * Test `_resolveValidUserId`:
     * Asserts rejection when `rawUserId` is null or invalid ObjectId.
     * Confirms no fallback to `project.owner_ref`.
   * Test `_sanitizePath`:
     * Asserts rejection on `../../etc/passwd`, `/../root.tex`.
     * Asserts acceptance on `main.tex`, `chapters/intro.tex`.

2. **Acceptance / Controller Tests**:
   * Test `AiAssistRunRouter` & `AiAssistRunController`:
     * Unauthorized user attempting `GET /ai-assist/projects/:Project_id/runs/:runId/stream` receives `403`.
     * Request with mismatched `Project_id` vs `run.projectId` receives `403`.
     * `createRun` with invalid `baseUrl` receives `400`.
     * Run ID generation yields 128-bit randomness.
