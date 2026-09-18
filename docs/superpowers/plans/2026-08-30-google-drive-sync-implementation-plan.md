# Google Drive Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement two-way Google Drive synchronization for Overleaf Community Edition via Google OAuth2, background change token polling, on-demand project syncing, and full UI integration in Account Settings and Project Editor with clean feature toggling.

**Architecture:** A dedicated feature module (`GoogleDriveSync`) in `services/web` managing Google OAuth2 credentials, token encryption, Google Drive API v3 operations, incremental change detection (`changes.list`), doc/file reconciliation with Overleaf `EditorController`, and frontend UI components in Account Settings and IDE Integrations panel.

**Tech Stack:** Node.js (ES Modules), Express, MongoDB (Mongoose/MongoDB Legacy), Google Drive REST API v3, React 18, TypeScript, SCSS, Vitest / Chai / Sinon.

**Spec:** `overleaf/docs/superpowers/specs/2026-08-30-google-drive-sync-design.md`

## Global Constraints
- `ENABLE_GOOGLE_DRIVE_SYNC` master boolean flag controls backend route mounting, background workers, and frontend visibility.
- When disabled, all routes are unmounted and UI elements in Account Settings and IDE Rail are completely omitted.
- Access and refresh tokens must be encrypted at rest using AES-256-GCM with `Settings.security.sessionSecret`.
- Ignore LaTeX compile artifacts during sync (`.aux`, `.log`, `.toc`, `.out`, `.synctex.gz`, `.fls`, `.fdb_latexmk`, etc.).
- Concurrent edit conflicts preserve Overleaf's live version and create a timestamped conflict copy `<name> (Google Drive Conflict YYYY-MM-DD-HHmm).<ext>`.
- Inbound Drive edits are recorded in Overleaf project history with `origin: { kind: 'google-drive' }`.

---

### Task 1: Configuration, Feature Flag & MongoDB Schemas

**Files:**
- Modify: `overleaf/services/web/config/settings.defaults.js`
- Modify: `overleaf/services/web/app/src/infrastructure/Features.mjs`
- Modify: `overleaf/services/web/app/src/infrastructure/mongodb.mjs`
- Modify: `overleaf/services/web/app/src/Features/User/UserPagesController.mjs`
- Modify: `overleaf/services/web/app/src/Features/Project/ProjectController.mjs`
- Modify: `overleaf/services/web/app/views/user/settings.pug`
- Modify: `overleaf/services/web/app/views/project/editor/_meta.pug`
- Test: `overleaf/services/web/test/unit/src/infrastructure/Features.test.mjs`

**Interfaces:**
- Consumes: `process.env.ENABLE_GOOGLE_DRIVE_SYNC`, `process.env.GOOGLE_DRIVE_CLIENT_ID`, `process.env.GOOGLE_DRIVE_CLIENT_SECRET`
- Produces: `Features.hasFeature('google-drive-sync')`, `Settings.enableGoogleDriveSync`, `Settings.googleDrive`, MongoDB collections `googleDriveUserCredentials` and `googleDriveProjectStates`, meta tags `ol-googleDriveSyncEnabled`

- [ ] **Step 1: Write the failing unit test for `google-drive-sync` feature flag**

In `overleaf/services/web/test/unit/src/infrastructure/Features.test.mjs`, add tests verifying `Features.hasFeature('google-drive-sync')` returns true when `Settings.enableGoogleDriveSync = true` and false when false/undefined.

```javascript
describe('google-drive-sync', function () {
  it('returns true when enableGoogleDriveSync is true', function (ctx) {
    ctx.settings.enableGoogleDriveSync = true
    expect(Features.hasFeature('google-drive-sync')).to.be.true
  })

  it('returns false when enableGoogleDriveSync is false', function (ctx) {
    ctx.settings.enableGoogleDriveSync = false
    expect(Features.hasFeature('google-drive-sync')).to.be.false
  })
})
```

- [ ] **Step 2: Add configuration settings in `settings.defaults.js`**

In `overleaf/services/web/config/settings.defaults.js`, add:
```javascript
enableGoogleDriveSync: process.env.ENABLE_GOOGLE_DRIVE_SYNC === 'true',
googleDrive: {
  clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
  redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI || `${siteUrl}/user/google-drive/callback`,
  folderName: process.env.GOOGLE_DRIVE_FOLDER_NAME || 'Overleaf',
  pollIntervalSeconds: intFromEnv('GOOGLE_DRIVE_POLL_INTERVAL_SECONDS', 60),
},
```

- [ ] **Step 3: Update `Features.mjs` to handle `google-drive-sync`**

In `overleaf/services/web/app/src/infrastructure/Features.mjs`:
```javascript
case 'google-drive-sync':
  return Boolean(Settings.enableGoogleDriveSync)
```

- [ ] **Step 4: Add MongoDB schemas in `mongodb.mjs`**

In `overleaf/services/web/app/src/infrastructure/mongodb.mjs`, register schemas and collections for `googleDriveUserCredentials` and `googleDriveProjectStates`:
```javascript
const GoogleDriveUserCredentialsSchema = new Schema(
  {
    user_id: { type: ObjectId, ref: 'User', index: true, unique: true },
    googleEmail: String,
    googleUserId: String,
    encryptedAccessToken: String,
    encryptedRefreshToken: String,
    tokenExpiry: Date,
    rootFolderId: String,
    startPageToken: String,
    linkedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { collection: 'googleDriveUserCredentials' }
)

const GoogleDriveProjectStatesSchema = new Schema(
  {
    projectId: { type: ObjectId, ref: 'Project', index: true, unique: true },
    userId: { type: ObjectId, ref: 'User', index: true },
    driveFolderId: String,
    folderName: String,
    fileMap: { type: Map, of: Schema.Types.Mixed, default: {} },
    syncStatus: { type: String, enum: ['idle', 'syncing', 'error'], default: 'idle' },
    lastSyncedAt: Date,
    lastError: String,
    isSyncing: { type: Boolean, default: false },
    lockExpiresAt: Date
  },
  { collection: 'googleDriveProjectStates' }
)
```

- [ ] **Step 5: Pass `googleDriveSyncEnabled` to views**

Update `UserPagesController.mjs`, `ProjectController.mjs`, `settings.pug`, and `_meta.pug` to expose `googleDriveSyncEnabled: Features.hasFeature('google-drive-sync')` and `meta(name="ol-googleDriveSyncEnabled" data-type="boolean" content=googleDriveSyncEnabled)`.

---

### Task 2: Google Drive OAuth2 Manager & Token Encryption

**Files:**
- Create: `overleaf/services/web/app/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.mjs`
- Test: `overleaf/services/web/test/unit/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.test.mjs`

**Interfaces:**
- Consumes: `Settings.googleDrive`, `Settings.security.sessionSecret`, `db.googleDriveUserCredentials`
- Produces:
  - `getAuthorizationUrl(userId)`: returns `{ url, state }`
  - `handleOAuthCallback(userId, code, state)`: exchanges code, fetches user info, encrypts tokens, saves to DB
  - `getValidAccessToken(userId)`: returns decrypted access token, automatically refreshing if expired
  - `unlinkAccount(userId)`: deletes credentials and revokes tokens
  - `isLinked(userId)`: returns boolean and profile info

- [ ] **Step 1: Write unit tests for `GoogleDriveOAuthManager`**

Test OAuth URL generation, state validation, AES-256-GCM encryption/decryption roundtrip, token exchange handling, automatic token refresh, and unlinking.

- [ ] **Step 2: Implement AES-256-GCM token encryption helpers**

In `GoogleDriveOAuthManager.mjs`, implement `encryptToken(text, secret)` and `decryptToken(encryptedText, secret)` using Node.js `crypto` with random 12-byte IV and auth tag.

- [ ] **Step 3: Implement OAuth2 URL builder and code exchange**

Implement `getAuthorizationUrl` using standard Google OAuth2 endpoints (`https://accounts.google.com/o/oauth2/v2/auth`) requesting scopes:
`https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email`.
Implement `handleOAuthCallback` calling `https://oauth2.googleapis.com/token` and `https://www.googleapis.com/oauth2/v2/userinfo`.

- [ ] **Step 4: Implement `getValidAccessToken` with auto-refresh**

Check `tokenExpiry`. If expiring within 5 minutes, exchange `encryptedRefreshToken` at `https://oauth2.googleapis.com/token` for a fresh `access_token`, update DB, and return the new token.

---

### Task 3: Google Drive REST API Client

**Files:**
- Create: `overleaf/services/web/app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs`
- Test: `overleaf/services/web/test/unit/src/Features/GoogleDriveSync/GoogleDriveClient.test.mjs`

**Interfaces:**
- Consumes: `GoogleDriveOAuthManager.getValidAccessToken(userId)`
- Produces:
  - `getOrCreateRootFolder(userId, folderName)`
  - `getOrCreateProjectFolder(userId, rootFolderId, projectName)`
  - `uploadFile(userId, parentFolderId, fileName, contentStream, mimeType, existingFileId)`
  - `downloadFile(userId, fileId)`
  - `deleteFile(userId, fileId)`
  - `getChanges(userId, pageToken)`
  - `getStartPageToken(userId)`

- [ ] **Step 1: Write unit tests for `GoogleDriveClient` with mocked Google Drive API**

Test creating root/subfolders, uploading files (multipart/resumable), downloading files as readable streams, deleting files, and retrieving change tokens via `changes.list`.

- [ ] **Step 2: Implement folder lookup and creation methods**

Implement `getOrCreateRootFolder` (querying `mimeType = 'application/vnd.google-apps.folder' and name = 'Overleaf' and trashed = false`) and `getOrCreateProjectFolder`.

- [ ] **Step 3: Implement file upload and download streaming**

Implement `uploadFile` handling both insert and update via Google Drive API v3 `/upload/drive/v3/files` and `downloadFile` via `/drive/v3/files/${fileId}?alt=media`.

- [ ] **Step 4: Implement incremental change tracking (`changes.list`)**

Implement `getStartPageToken` and `getChanges` returning `{ changes, newStartPageToken }`.

---

### Task 4: Synchronization Engine & Conflict Manager

**Files:**
- Create: `overleaf/services/web/app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs`
- Test: `overleaf/services/web/test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs`

**Interfaces:**
- Consumes: `GoogleDriveClient`, `GoogleDriveOAuthManager`, `EditorController`, `ProjectEntityHandler`, `DocstoreManager`, `FileStoreController`
- Produces:
  - `syncProject(projectId, userId)`: full bidirectional sync for a project
  - `handleOutboundDocUpdate(projectId, docId, path, rev)`
  - `handleOutboundFileUpdate(projectId, fileId, path, hash)`
  - `handleOutboundDelete(projectId, path)`
  - `pollUserChanges(userId)`: checks `changes.list` for a linked user and updates all affected projects

- [ ] **Step 1: Write unit tests for `GoogleDriveSyncManager`**

Test file filtering (ignored `.aux`, `.log`, etc.), outbound doc/file pushes, inbound reconciliation via `EditorController`, and conflict copy generation when files are edited in both locations concurrently.

- [ ] **Step 2: Implement file ignore logic**

Implement `isIgnoredFile(filePath)` matching:
`/\.(aux|log|toc|out|synctex\.gz|fls|fdb_latexmk|bbl|blg|nav|snm|vrb|dvi|ps|lof|lot)$/i` and OS noise files (`.DS_Store`, `Thumbs.db`).

- [ ] **Step 3: Implement outbound synchronization**

Implement `handleOutboundDocUpdate`, `handleOutboundFileUpdate`, `handleOutboundDelete`. Stream content to Google Drive and update `fileMap` in `googleDriveProjectStates`.

- [ ] **Step 4: Implement inbound synchronization and conflict copy generation**

Implement `syncProject` and `pollUserChanges`:
- If an entity changed in Drive and not in Overleaf $\rightarrow$ call `EditorController.promises.upsertDocWithPath` or `upsertFileWithPath` with `source: 'google-drive'`.
- If an entity changed in both places $\rightarrow$ keep Overleaf version and create `<name> (Google Drive Conflict YYYY-MM-DD-HHmm).<ext>`.
- If a file is deleted in Drive $\rightarrow$ call `EditorController.promises.deleteEntityWithPath`.

---

### Task 5: HTTP Controller, Router & Background Polling Worker

**Files:**
- Create: `overleaf/services/web/app/src/Features/GoogleDriveSync/GoogleDriveController.mjs`
- Create: `overleaf/services/web/app/src/Features/GoogleDriveSync/GoogleDriveRouter.mjs`
- Create: `overleaf/services/web/app/src/Features/GoogleDriveSync/GoogleDrivePollingWorker.mjs`
- Modify: `overleaf/services/web/app/src/router.mjs`
- Test: `overleaf/services/web/test/unit/src/Features/GoogleDriveSync/GoogleDriveRouter.test.mjs`
- Test: `overleaf/services/web/test/unit/src/Features/GoogleDriveSync/GoogleDriveController.test.mjs`

**Interfaces:**
- Consumes: `GoogleDriveOAuthManager`, `GoogleDriveSyncManager`, `Features.hasFeature('google-drive-sync')`
- Produces:
  - `GET /user/google-drive/oauth`
  - `GET /user/google-drive/callback`
  - `POST /user/google-drive/unlink`
  - `GET /project/:projectId/google-drive/status`
  - `POST /project/:projectId/google-drive/sync`
  - Background worker loop starting at web service boot

- [ ] **Step 1: Write unit tests for `GoogleDriveRouter` and `GoogleDriveController`**

Verify route authentication middleware, parameter validation, JSON responses, error handling, and confirming routes are unmounted when `ENABLE_GOOGLE_DRIVE_SYNC=false`.

- [ ] **Step 2: Implement `GoogleDriveController`**

Implement handlers for `startOAuth`, `oauthCallback`, `unlink`, `getProjectStatus`, and `syncProjectNow`.

- [ ] **Step 3: Implement `GoogleDriveRouter` and wire into `router.mjs`**

Implement `GoogleDriveRouter.apply(webRouter, privateApiRouter)` guarded by `Features.hasFeature('google-drive-sync')`.

- [ ] **Step 4: Implement `GoogleDrivePollingWorker`**

Implement background timer running every `GOOGLE_DRIVE_POLL_INTERVAL_SECONDS` that fetches all linked users from `googleDriveUserCredentials` and calls `GoogleDriveSyncManager.pollUserChanges(user._id)`.

---

### Task 6: Frontend - Account Settings Linking Widget

**Files:**
- Create: `overleaf/services/web/frontend/js/shared/svgs/google-drive-logo.tsx`
- Create: `overleaf/services/web/frontend/js/features/settings/components/linking/google-drive-widget.tsx`
- Modify: `overleaf/services/web/frontend/js/features/settings/components/linking-section.tsx`
- Test: `overleaf/services/web/frontend/js/features/settings/components/linking/google-drive-widget.test.tsx`

**Interfaces:**
- Consumes: `getMeta('ol-googleDriveSyncEnabled')`, `GET /user/settings` data
- Produces: Google Drive widget rendered inside `LinkingSection` under "Project Synchronization"

- [ ] **Step 1: Create `GoogleDriveLogo` SVG component**

Create `overleaf/services/web/frontend/js/shared/svgs/google-drive-logo.tsx` with Google Drive brand colors and scalable `size` prop.

- [ ] **Step 2: Implement `GoogleDriveLinkingWidget`**

Implement `google-drive-widget.tsx`:
- Unlinked state: Title "Google Drive", description "Synchronize your Overleaf projects with Google Drive", and "Link to Google Drive" button directing to `/user/google-drive/oauth`.
- Linked state: Connected checkmark, "Linked as **email@gmail.com**", last sync timestamp, and "Unlink Google Drive" button with confirmation modal calling `POST /user/google-drive/unlink`.

- [ ] **Step 3: Wire into `LinkingSection`**

In `linking-section.tsx`, import and render `GoogleDriveLinkingWidget` when `getMeta('ol-googleDriveSyncEnabled')` is true.

---

### Task 7: Frontend - Project Editor Integrations Panel & Modal

**Files:**
- Create: `overleaf/services/web/frontend/js/features/ide-react/components/modals/google-drive-modal.tsx`
- Modify: `overleaf/services/web/frontend/js/features/ide-react/context/rail-context.tsx`
- Modify: `overleaf/services/web/frontend/js/features/ide-react/components/rail/rail-modals.tsx`
- Modify: `overleaf/services/web/frontend/js/features/integrations-panel/integrations-panel.tsx`
- Modify: `overleaf/services/web/frontend/js/features/ide-react/components/rail/rail.tsx`
- Test: `overleaf/services/web/frontend/js/features/ide-react/components/modals/google-drive-modal.test.tsx`

**Interfaces:**
- Consumes: `getMeta('ol-googleDriveSyncEnabled')`, `GET /project/:projectId/google-drive/status`, `POST /project/:projectId/google-drive/sync`
- Produces: Google Drive integration card in `IntegrationsPanel`, `GoogleDriveModal` with live status, folder link, and on-demand sync trigger

- [ ] **Step 1: Implement `GoogleDriveModal`**

Implement `google-drive-modal.tsx`:
- Fetches status from `/project/:projectId/google-drive/status`.
- Shows status badge (`Up to date`, `Syncing`, `Error`, `Not linked`).
- Shows `Open folder in Google Drive ↗` external link.
- Shows "Sync this project now" button with spinning loader while syncing.
- Shows conflict alerts if conflict files were created.

- [ ] **Step 2: Register modal in `rail-context.tsx` and `rail-modals.tsx`**

Add `'google-drive'` to `RailModalKey` in `rail-context.tsx` and register `GoogleDriveModal` in `RAIL_MODALS` array in `rail-modals.tsx`.

- [ ] **Step 3: Add Google Drive card in `IntegrationsPanel` and update `rail.tsx`**

In `integrations-panel.tsx`:
When `googleDriveSyncEnabled` is true, render a card button with `GoogleDriveLogo`, title "Google Drive", and description "Synchronize with Google Drive", triggering `setActiveModal('google-drive')`.
In `rail.tsx`:
Update rail hide condition: `hide: !isOverleaf && !gitBridgeEnabled && !googleDriveSyncEnabled`.

---

### Task 8: Verification & End-to-End Review

**Files:**
- Test all backend unit tests: `overleaf/services/web/test/unit/src/Features/GoogleDriveSync/*.test.mjs`
- Test all frontend unit tests: `overleaf/services/web/frontend/js/features/**/*.test.tsx`

**Interfaces:**
- Verifies complete feature toggle and end-to-end integration

- [ ] **Step 1: Verify all backend unit tests pass**
- [ ] **Step 2: Verify clean disablement behavior when `ENABLE_GOOGLE_DRIVE_SYNC=false`**
- [ ] **Step 3: Final codebase review and verification checklist**
