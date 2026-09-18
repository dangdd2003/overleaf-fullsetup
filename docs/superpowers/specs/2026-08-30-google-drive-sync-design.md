# Design Specification: Google Drive Synchronization for Overleaf Community Edition

**Date**: 2026-08-30  
**Status**: Approved / Ready for Implementation Planning  
**Target**: Overleaf Community Edition (Server CE)

---

## 1. Overview & Goals

Google Drive Synchronization connects an Overleaf user account with their Google Drive via OAuth2 and provides automatic, two-way folder synchronization patterned after Overleaf's official Dropbox feature. It synchronizes active Overleaf projects to subfolders within a dedicated `Overleaf/` root folder in Google Drive, allowing users to edit files offline or on other devices, back up projects, and seamlessly sync changes back into Overleaf.

### 1.1 Core Principles & Behavioral Model
- **Two-Way Synchronization**:
  - **Overleaf $\rightarrow$ Google Drive**: Source documents, images, and project assets edited in Overleaf are pushed to the corresponding Google Drive project folder.
  - **Google Drive $\rightarrow$ Overleaf**: Files added, modified, or deleted in `Google Drive > Overleaf > <Project Name>/` are reflected in Overleaf. Creating a new folder inside `Overleaf/` creates a new Overleaf project.
- **Dedicated Root Namespace**:
  - All projects sync under a dedicated root folder `Google Drive > Overleaf/` (configurable via `GOOGLE_DRIVE_FOLDER_NAME`).
  - Project names map directly to folder names.
- **Sync Triggering**:
  - Incremental background change polling using Google Drive API v3 `changes.list` (Change Tokens).
  - Manual on-demand sync via "Sync this project now" in the editor's Integrations panel.
- **Clean Feature Toggle**:
  - Controlled by `ENABLE_GOOGLE_DRIVE_SYNC`.
  - When disabled, backend routes and workers are unmounted, and all UI elements in Account Settings and the Project Editor are omitted completely (matching the clean disablement behavior of Git integration).

---

## 2. System Architecture

```
+-----------------------------------------------------------------------------------------+
|                                    User Browser                                         |
|  - Account Settings (/user/settings): GoogleDriveLinkingWidget (Link / Unlink account)  |
|  - Project Editor: IntegrationsPanel card + GoogleDriveModal (Status, Folder link, Sync) |
+-----------------------------------------------------------------------------------------+
                                             |
                                             v
+-----------------------------------------------------------------------------------------+
| Overleaf Web Service (services/web - Node.js Express)                                  |
|                                                                                         |
|  [GoogleDriveRouter]                                                                    |
|    - GET  /user/google-drive/oauth             (initiates Google OAuth2 consent)        |
|    - GET  /user/google-drive/callback          (exchanges auth code, saves credentials) |
|    - POST /user/google-drive/unlink            (revokes / deletes stored credentials)   |
|    - GET  /project/:projectId/google-drive/status   (gets sync state, Drive folder link)|
|    - POST /project/:projectId/google-drive/sync     (triggers immediate sync)           |
|                                                                                         |
|  [GoogleDriveOAuthManager]                                                              |
|    - Builds OAuth consent URL (drive scope, access_type=offline, prompt=consent)       |
|    - Exchanges auth code for tokens, handles AES-256-GCM token encryption/decryption   |
|    - Manages automatic token refresh on expiration                                      |
|                                                                                         |
|  [GoogleDriveClient]                                                                    |
|    - Wrapper around Google Drive REST API v3 (files.create, update, get, delete, list)  |
|    - Manages change tokens via changes.list & changes.getStartPageToken                 |
|                                                                                         |
|  [GoogleDriveSyncManager]                                                               |
|    - Reconciles Overleaf project entities with Google Drive files                       |
|    - Inbound sync: applies Drive edits via EditorController (upsertDoc/upsertFile/delete)|
|    - Outbound sync: pushes Overleaf entity mutations to Google Drive API                |
|    - Filters out LaTeX compilation artifacts (.aux, .log, .toc, .out, .synctex.gz, etc.)|
|    - Manages concurrency via Mongo locks and conflict file generation                   |
|                                                                                         |
|  [GoogleDrivePollingWorker]                                                             |
|    - Background worker periodically polling changes.list for linked users               |
+-----------------------------------------------------------------------------------------+
          |                                               |
          v                                               v
+-----------------------------------+   +------------------------------------+
| MongoDB Collections               |   | Google Drive API v3 (REST)         |
|  - googleDriveUserCredentials     |   |  - Root Folder: "Overleaf"         |
|  - googleDriveProjectStates       |   |  - Project Folders: "<Name>"       |
+-----------------------------------+   +------------------------------------+
```

---

## 3. Data Models & Database Schemas

Defined in `overleaf/services/web/app/src/infrastructure/mongodb.mjs`:

### 3.1 `googleDriveUserCredentials`
Persists the OAuth2 credentials and sync state for each linked Overleaf user:
```javascript
{
  _id: ObjectId,              // Unique identifier (matches user_id or indexed)
  user_id: ObjectId,          // Reference to Overleaf User _id (Indexed, Unique)
  googleEmail: String,        // User's Google account email address
  googleUserId: String,       // Google account subject ID
  encryptedAccessToken: String,  // AES-256-GCM encrypted access token
  encryptedRefreshToken: String, // AES-256-GCM encrypted refresh token
  tokenExpiry: Date,          // Access token expiration timestamp
  rootFolderId: String,       // Google Drive ID of the "Overleaf" root folder
  startPageToken: String,     // Latest Google Drive changes.list pageToken
  linkedAt: Date,             // Timestamp when account was linked
  updatedAt: Date             // Timestamp of last credential update
}
```

### 3.2 `googleDriveProjectStates`
Tracks the synchronization state, folder IDs, and entity mappings for each linked project:
```javascript
{
  _id: ObjectId,              // Unique identifier
  projectId: ObjectId,        // Reference to Project _id (Indexed, Unique)
  userId: ObjectId,           // User who owns the synchronization
  driveFolderId: String,      // Google Drive Folder ID for this project
  folderName: String,         // Google Drive folder name
  fileMap: {                  // Key: relative file path (e.g. "main.tex", "figures/plot.png")
    type: Map,
    of: {
      driveFileId: String,
      md5Checksum: String,
      modifiedTime: Date,
      rev: Number,
      entityId: ObjectId,
      entityType: String      // "doc" | "file"
    }
  },
  syncStatus: String,         // "idle" | "syncing" | "error"
  lastSyncedAt: Date,         // Timestamp of last successful sync
  lastError: String,          // Last error message (if any)
  isSyncing: Boolean,         // Concurrency lock flag
  lockExpiresAt: Date         // Lock expiration TTL to prevent deadlocks
}
```

---

## 4. Synchronization Logic & Conflict Handling

### 4.1 Ignored File Patterns
LaTeX compilation generates transient files that should not trigger Google Drive API calls. The following file extensions are ignored during sync:
```
.aux, .log, .toc, .out, .synctex.gz, .fls, .fdb_latexmk, .bbl, .blg, .nav, .snm, .vrb, .dvi, .ps, .lof, .lot
```
Source LaTeX files (`.tex`, `.bib`, `.sty`, `.cls`), assets/images (`.png`, `.jpg`, `.pdf` when stored as project source assets, `.svg`, `.eps`), and project data files (`.csv`, `.txt`, `.json`) are synchronized.

### 4.2 Outbound Sync (Overleaf $\rightarrow$ Google Drive)
1. When a doc or file is upserted or deleted in Overleaf, `GoogleDriveSyncManager` checks if the project has an active Google Drive link.
2. If the entity is ignored (compile artifact), it is skipped.
3. For docs, content is fetched from DocStore and updated via `files.update` (or created via `files.create`) as UTF-8 text.
4. For binary files, content is streamed from FileStore / Project History and uploaded via multipart/resumable upload.
5. The `googleDriveProjectStates.fileMap` is updated with the new `driveFileId`, `md5Checksum`, and `rev`.

### 4.3 Inbound Sync (Google Drive $\rightarrow$ Overleaf)
1. Executed during background polling (`changes.list`) or on-demand sync request.
2. For each change detected inside a project folder:
   * **Modified Doc**: Downloads file, checks if content differs from Overleaf. If different and not conflicting, calls `EditorController.upsertDocWithPath(projectId, path, lines, 'google-drive', userId)`.
   * **Modified Binary File**: Streams file to temporary disk and calls `EditorController.upsertFileWithPath(projectId, path, fsPath, 'google-drive', userId)`.
   * **Deleted File**: Calls `EditorController.deleteEntityWithPath(projectId, path, 'google-drive', userId)`.
3. For new folders created in the root `Overleaf/` folder in Google Drive:
   * Creates a new blank Overleaf project with that name and imports all contained files.
4. For deleted project folders in Google Drive:
   * Deletes all entities inside the Overleaf project while keeping the project container and history intact (matching Dropbox behavior).
5. All updates are tagged with history origin `{ kind: 'google-drive' }`.

### 4.4 Conflict Resolution
- If an entity was modified in Overleaf and also modified in Google Drive between sync cycles:
  - Overleaf's live editor version is preserved in place.
  - The incoming Google Drive version is written as a conflict file:  
    `path/to/filename (Google Drive Conflict YYYY-MM-DD-HHmm).ext`
  - A notification is recorded in the project sync state and displayed in the sync modal.

---

## 5. Frontend & UI Design

### 5.1 Account Settings (`/user/settings`)
* **Component**: `GoogleDriveLinkingWidget` (inside `LinkingSection` under "Project Synchronization").
* **Unlinked State**:
  * Displays Google Drive icon, title "Google Drive", description "Synchronize your Overleaf projects with Google Drive."
  * Button: **"Link to Google Drive"** (redirects to `/user/google-drive/oauth`).
* **Linked State**:
  * Displays green connected checkmark, "Linked as **user@gmail.com**".
  * Displays last synchronized time.
  * Button: **"Unlink Google Drive"** with a confirmation dialog.

### 5.2 Project Editor (Left Sidebar / Rail)
* **Component**: `IntegrationsPanel` card & `GoogleDriveModal`.
* **Card Button**: Shows Google Drive icon, title "Google Drive", description "Synchronize with Google Drive", clicking opens modal.
* **Modal Details**:
  * Status indicator: `Up to date`, `Syncing...`, `Sync Error`, or `Not Linked`.
  * Google Drive folder link: `Open folder in Google Drive ↗`.
  * Primary Action: **"Sync this project now"** button with spinning loader during sync execution.
  * Conflict / error banner alert if any conflicts were detected.

---

## 6. Configuration & Environment Variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `ENABLE_GOOGLE_DRIVE_SYNC` | boolean | `false` | Master toggle to enable/disable the feature |
| `GOOGLE_DRIVE_CLIENT_ID` | string | `""` | Google Cloud OAuth2 Client ID |
| `GOOGLE_DRIVE_CLIENT_SECRET` | string | `""` | Google Cloud OAuth2 Client Secret |
| `GOOGLE_DRIVE_REDIRECT_URI` | string | `{siteUrl}/user/google-drive/callback` | OAuth2 redirect URL callback |
| `GOOGLE_DRIVE_FOLDER_NAME` | string | `"Overleaf"` | Root folder name created in Google Drive |
| `GOOGLE_DRIVE_POLL_INTERVAL_SECONDS` | number | `60` | Background poll interval for changes.list |

### Clean Disablement Rules:
- If `ENABLE_GOOGLE_DRIVE_SYNC` is `false` (or unset):
  - `Features.hasFeature('google-drive-sync')` returns `false`.
  - Backend routes under `/user/google-drive/*` and `/project/:id/google-drive/*` are unmounted.
  - Background polling worker is dormant.
  - Frontend meta tag `ol-googleDriveSyncEnabled` is `false`.
  - `GoogleDriveLinkingWidget` is omitted from Account Settings.
  - Google Drive card is omitted from the editor's `IntegrationsPanel`.

---

## 7. Testing Strategy

1. **Unit Tests (Backend)**:
   * `GoogleDriveOAuthManager.test.mjs`: OAuth URL generation, state validation, token encryption/decryption, refresh logic.
   * `GoogleDriveClient.test.mjs`: Google Drive API mock calls for `files.list`, `files.create`, `files.update`, `changes.list`.
   * `GoogleDriveSyncManager.test.mjs`: Directory reconciliation, file ignore filtering, conflict copy creation, project creation/deletion.
   * `GoogleDriveRouter.test.mjs`: Route mounting tests when enabled vs disabled.
2. **Unit Tests (Frontend)**:
   * `GoogleDriveLinkingWidget.test.tsx`: Linked/unlinked states, modal triggers.
   * `GoogleDriveModal.test.tsx`: Sync status display, "Sync now" action, conflict banners.
   * `IntegrationsPanel.test.tsx`: Card rendering when enabled vs omitted when disabled.
