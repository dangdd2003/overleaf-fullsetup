# Google Drive Sync — Data Integrity & Advanced Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full data integrity and advanced parity behaviors for Google Drive Sync: conflict copies when both sides diverge concurrently, rename/move preservation without history or comment loss using Drive's stable file IDs, duplicate project name collision resolution, and conflict banner UI in the editor modal.

**Architecture:** Inbound sync (`pollUserChanges` and `syncProject`) detects when both local Overleaf and remote Drive files have diverged from the baseline checksum; instead of overwriting Overleaf's live version, it writes the Drive version as a conflict copy (`filename (Google Drive Conflict YYYY-MM-DD-HHmm).ext`) and logs it to `state.conflicts`. Outbound worker performs a pre-push metadata check to defer to inbound conflict resolution when Drive changes first. Stable Drive file IDs are indexed to trigger `EditorController.renameEntity` / `moveEntity` rather than destructive delete-and-recreate cycles. Name collisions for folders and projects append numerical suffixes (` 1` / ` (1)`).

**Tech Stack:** Node.js ESM, Express, MongoDB, React, TypeScript, Vitest with `vi.doMock`, Mocha/Chai (frontend tests), `@overleaf/settings`, `@overleaf/logger`, `EditorController`, `ProjectGetter`.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-02-google-drive-sync-dropbox-parity-design.md` — implements **Phase 4** (§4.4, §5, §6, §7).

## Global Constraints

- **Working directory for every command is `overleaf/services/web`.** All paths in this plan are relative to it unless stated otherwise.
- **Backend test command is `npx vitest run <path>`.**
- **Frontend test command is `npm test test/frontend/features/ide-react/google-drive-modal.test.tsx`** or `npx mocha test/frontend/features/ide-react/google-drive-modal.test.tsx`.
- **Feature must remain disabled by default.** `ENABLE_GOOGLE_DRIVE_SYNC` defaults to `false`.
- **Never commit.** This repository reserves all git operations for the user. Steps that would normally commit instead say "stop and report" — the user commits.
- **ESM only** for backend files (`.mjs`).

---

## File Structure

**Modified:**

| File | Responsibility |
|---|---|
| `app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs` | Conflict copy generation in `syncProject`/`pollUserChanges`, rename/move by Drive ID, duplicate folder/project name collision suffixing. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs` | Unit tests for conflict detection, rename-by-ID, move-by-ID, and collision suffixing. |
| `app/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.mjs` | Pre-push remote divergence check using `GoogleDriveClient.getFileMetadata`. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.test.mjs` | Unit tests for outbound divergence check deferral. |
| `app/src/Features/GoogleDriveSync/GoogleDriveController.mjs` | `dismissConflicts` endpoint and `getProjectStatus` returning `conflicts`, `syncSuspended`, `suspendReason`. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveController.test.mjs` | Unit tests for `dismissConflicts`. |
| `app/src/Features/GoogleDriveSync/GoogleDriveRouter.mjs` | Mount `POST /project/:Project_id/google-drive/conflicts/dismiss`. |
| `test/unit/src/Features/GoogleDriveSync/GoogleDriveRouter.test.mjs` | Unit tests for conflict dismiss route mounting. |
| `frontend/js/features/ide-react/components/modals/google-drive-modal.tsx` | Conflict alert banner with dismiss button, and sync suspended warning banner. |
| `test/frontend/features/ide-react/google-drive-modal.test.tsx` | Frontend tests for conflict banner rendering and dismissal. |

**Task dependency order:** 1 → 2 → 3 → 4 → 5.

---

## Task 1: Conflict copy creation & outbound divergence check

Implements two-way conflict detection: inbound writes Drive version to `generateConflictPath(path)` and records to `state.conflicts`; outbound checks remote metadata before push and defers to inbound when Drive has diverged.

**Files:**
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs`
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.test.mjs`

**Interfaces:**
- Consumes: `generateConflictPath(path, date)` (already in `GoogleDriveSyncManager.mjs`), `GoogleDriveClient.getFileMetadata`.
- Produces:
  - Inbound conflict copy creation storing records `{ path, conflictPath, detectedAt }` in `state.conflicts` on `db.googleDriveProjectStates`.
  - Outbound pre-push check skipping push when remote checksum has changed.

- [ ] **Step 1: Write failing unit tests in `GoogleDriveSyncManager.test.mjs`**

Add unit tests to `test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs` asserting that when `driveFile.md5Checksum !== mapped.md5Checksum` AND current Overleaf doc/file MD5 !== `mapped.md5Checksum`:
1. Overleaf's live doc/file is NOT overwritten.
2. The incoming Drive content is written to a conflict file via `EditorController.promises.upsertDocWithPath` or `upsertFileWithPath` using the path from `generateConflictPath`.
3. `state.conflicts` array is updated on `googleDriveProjectStates` with `{ path, conflictPath, detectedAt }`.

- [ ] **Step 2: Write failing unit tests in `GoogleDriveOutboundWorker.test.mjs`**

Add unit tests to `test/unit/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.test.mjs` asserting that in `flushProject`:
1. If `state.fileMap[filePath]?.driveFileId` exists, `GoogleDriveClient.getFileMetadata` is called.
2. If the remote `md5Checksum` differs from `state.fileMap[filePath].md5Checksum`, `handleOutboundDocUpdate` is NOT called, and the path remains in `pendingChanges` for inbound conflict resolution.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs -t "conflict" test/unit/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.test.mjs -t "divergence"`
Expected: FAIL.

- [ ] **Step 4: Implement conflict handling in `GoogleDriveSyncManager.mjs`**

In `app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs`:
In `pollUserChanges` and `syncProject`:
When processing a remote change for `relPath`:
```javascript
const mapped = fileMap[relPath]
const driveChanged = driveFile.md5Checksum && mapped?.md5Checksum && driveFile.md5Checksum !== mapped.md5Checksum

// Calculate local Overleaf content hash
let localChanged = false
if (mapped?.md5Checksum) {
  if (ovEntity?.type === 'doc') {
    const doc = docMap[ovEntity.id?.toString()]
    const lines = doc?.lines || []
    const content = Array.isArray(lines) ? lines.join('\n') : lines || ''
    const localHash = crypto.createHash('md5').update(Buffer.from(content, 'utf8')).digest('hex')
    localChanged = localHash !== mapped.md5Checksum
  } else if (ovEntity?.hash) {
    localChanged = ovEntity.hash !== mapped.md5Checksum
  }
}

if (driveChanged && localChanged) {
  // Conflict! Keep Overleaf in place; write Drive content to conflict copy
  const conflictPath = generateConflictPath(relPath)
  logger.warn({ projectId, path: relPath, conflictPath }, 'GoogleDriveSync: conflict detected, creating conflict copy')
  
  if (isBinaryFile(relPath, driveFile.mimeType)) {
    // Download and write file
    const tmpPath = await GoogleDriveClient.downloadFileToTemp(userId, driveFile.id)
    await EditorController.promises.upsertFileWithPath(projectId, toElementPath(conflictPath), tmpPath, 'google-drive', effectiveUserId)
    try { await fs.promises.unlink(tmpPath) } catch {}
  } else {
    const buf = await GoogleDriveClient.downloadFileBuffer(userId, driveFile.id)
    const lines = buf.toString('utf8').split('\n')
    await EditorController.promises.upsertDocWithPath(projectId, toElementPath(conflictPath), lines, 'google-drive', effectiveUserId)
  }

  const conflictRecord = { path: relPath, conflictPath, detectedAt: new Date() }
  await db.googleDriveProjectStates.updateOne(
    { projectId: projectObjectId },
    {
      $push: {
        conflicts: {
          $each: [conflictRecord],
          $slice: -20, // Keep latest 20
        },
      },
    }
  )
}
```

- [ ] **Step 5: Implement outbound divergence check in `GoogleDriveOutboundWorker.mjs`**

In `app/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.mjs`, in `_applyChange`:
```javascript
  // For updates to existing files, verify remote has not diverged
  const mapped = state.fileMap?.[filePath]
  if (mapped?.driveFileId && entry.op === 'upsert') {
    try {
      const meta = await GoogleDriveClient.getFileMetadata(state.userId, mapped.driveFileId, 'id,name,md5Checksum,trashed')
      if (meta && meta.md5Checksum && mapped.md5Checksum && meta.md5Checksum !== mapped.md5Checksum) {
        logger.warn({ projectId, filePath }, 'GoogleDriveOutboundWorker: remote file diverged on Drive, deferring to inbound conflict sync')
        return
      }
    } catch (err) {
      if (err.info?.status !== 404) {
        throw err
      }
    }
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs test/unit/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.test.mjs`
Expected: PASS.

- [ ] **Step 7: Stop and report**

Do not commit. Report and wait.

---

## Task 2: Stable Drive file ID rename & move handling

Populates `entityId` and `entityType` on all `fileMap` writes and uses Drive stable file IDs to rename/move entities in Overleaf (`EditorController.renameEntity` / `moveEntity`) instead of delete+recreate.

**Files:**
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs`

**Interfaces:**
- Consumes: `EditorController.promises.renameEntity`, `EditorController.promises.moveEntity`, `GoogleDriveSyncManager.resolveDriveFolderHierarchy`.
- Produces: Inbound rename/move without history/comment loss.

- [ ] **Step 1: Write failing tests in `GoogleDriveSyncManager.test.mjs`**

Add unit tests verifying that in `pollUserChanges`:
1. When a change is received for a known `driveFileId` whose filename changed in the same folder, `EditorController.promises.renameEntity` is called with the entity ID and new name (and `deleteEntityWithPath` is NOT called).
2. When a change is received for a known `driveFileId` whose parent folder changed, `EditorController.promises.moveEntity` is called with the new parent folder ID (and `deleteEntityWithPath` is NOT called).
3. `fileMap` is rekeyed from the old path to the new path with `driveFileId`, `entityId`, and `entityType` intact.

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs -t "rename and move"`
Expected: FAIL.

- [ ] **Step 3: Implement stable ID rename and move in `GoogleDriveSyncManager.mjs`**

In `app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs`, in `pollUserChanges`:
1. Build reverse lookup `fileByDriveId[fInfo.driveFileId] = { state: st, path: p, info: fInfo }`.
2. When evaluating a change:
   - Calculate `newRelPath` from parent folders and `file.name`.
   - If `fileByDriveId[file.id]` exists and `fileByDriveId[file.id].path !== newRelPath`:
     - Retrieve `entityId` and `entityType` (`doc` or `file`).
     - Compare old dir and new dir:
       - If dirs differ: resolve new folder in Overleaf via `_ensureFolderPathInOverleaf`, call `EditorController.promises.moveEntity(projectId, entityId, newFolderId, entityType, userId, 'google-drive')`.
       - If names differ: call `EditorController.promises.renameEntity(projectId, entityId, entityType, path.posix.basename(newRelPath), userId, 'google-drive')`.
     - Update `fileMap`: `delete state.fileMap[oldPath]`, `state.fileMap[newRelPath] = { ...oldInfo, md5Checksum: file.md5Checksum }`.
     - Continue to content comparison for `newRelPath`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs`
Expected: PASS.

- [ ] **Step 5: Stop and report**

Do not commit. Report and wait.

---

## Task 3: Duplicate project name collision handling

Implements collision suffixing (`<Name> 1` / `<Name> (1)`) for project folders in Drive and projects in Overleaf, and records suspension when unresolvable.

**Files:**
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs`

**Interfaces:**
- Consumes: `ProjectGetter.promises.findUsersProjectsByName`.
- Produces: Conflict-free folder and project names with `syncSuspended` fallback.

- [ ] **Step 1: Write failing tests in `GoogleDriveSyncManager.test.mjs`**

Add unit tests verifying:
1. `getOrCreateProjectFolder` checks existing folder IDs first; on collision with a folder bound to another project, it appends ` 1`, ` 2`.
2. `_createProjectFromDriveFolder` checks active and trashed projects; on collision, it appends ` (1)`, ` (2)`.
3. If max attempts are reached, `syncSuspended: true` and `suspendReason` are set.

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs -t "duplicate project name"`
Expected: FAIL.

- [ ] **Step 3: Implement collision resolution in `GoogleDriveSyncManager.mjs`**

In `app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs`:
1. Update `getOrCreateProjectFolder(userId, rootFolderId, projectName, projectId)`:
   - List folder children of root.
   - If folder named `projectName` exists:
     - Check if bound to another project in `db.googleDriveProjectStates.findOne({ userId, driveFolderId: folder.id, projectId: { $ne: _toObjectId(projectId) } })`.
     - If bound to another project: iterate `suffix = 1..100`, testing `"${projectName} ${suffix}"`.
     - Create folder with unique suffix. If 100 exceeded, throw/set `syncSuspended`.
2. Update `_createProjectFromDriveFolder(userId, driveFolder)`:
   - Check collision with `ProjectGetter.promises.findUsersProjectsByName(userId, driveFolder.name)`.
   - If collision: iterate `suffix = 1..100`, testing `"${driveFolder.name} (${suffix})"`.
   - Create project with unique name.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveSyncManager.test.mjs`
Expected: PASS.

- [ ] **Step 5: Stop and report**

Do not commit. Report and wait.

---

## Task 4: Conflict Dismiss Endpoint & Frontend UI

Implements backend conflict dismissal endpoint and updates `google-drive-modal.tsx` to render conflict warning banners and suspended status.

**Files:**
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveController.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveController.test.mjs`
- Modify: `app/src/Features/GoogleDriveSync/GoogleDriveRouter.mjs`
- Test: `test/unit/src/Features/GoogleDriveSync/GoogleDriveRouter.test.mjs`
- Modify: `frontend/js/features/ide-react/components/modals/google-drive-modal.tsx`
- Test: `test/frontend/features/ide-react/google-drive-modal.test.tsx`

**Interfaces:**
- Route: `POST /project/:Project_id/google-drive/conflicts/dismiss` (login & write access required).
- Component: `GoogleDriveModal` displays conflict list with "Dismiss" button and "Sync suspended" alert.

- [ ] **Step 1: Write failing controller & router tests**

In `test/unit/src/Features/GoogleDriveSync/GoogleDriveController.test.mjs`:
Add test for `dismissConflicts` asserting it sets `conflicts: []` on `googleDriveProjectStates` and returns status.

In `test/unit/src/Features/GoogleDriveSync/GoogleDriveRouter.test.mjs`:
Add test verifying `POST /project/:Project_id/google-drive/conflicts/dismiss` is mounted with write permissions.

- [ ] **Step 2: Implement `dismissConflicts` in Controller and Router**

In `app/src/Features/GoogleDriveSync/GoogleDriveController.mjs`:
```javascript
  async dismissConflicts(req, res) {
    const projectId = req.params.Project_id
    const userId = SessionManager.getLoggedInUserId(req.session)

    try {
      await db.googleDriveProjectStates.updateOne(
        { projectId: _toObjectId(projectId) },
        { $set: { conflicts: [] } }
      )
      const status = await GoogleDriveSyncManager.getProjectStatus(projectId, userId)
      return res.json({ success: true, ...status })
    } catch (err) {
      logger.error({ err, projectId }, 'error dismissing google drive conflicts')
      return res.status(500).json({ code: 'error', message: err.message })
    }
  },
```

In `app/src/Features/GoogleDriveSync/GoogleDriveRouter.mjs`:
```javascript
    webRouter.post(
      '/project/:Project_id/google-drive/conflicts/dismiss',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      GoogleDriveController.dismissConflicts
    )
```

- [ ] **Step 3: Update `google-drive-modal.tsx` UI**

In `frontend/js/features/ide-react/components/modals/google-drive-modal.tsx`:
1. Add `conflicts?: Array<{ path: string, conflictPath: string, detectedAt: string }>` and `syncSuspended?: boolean`, `suspendReason?: string` to `GoogleDriveStatus` interface.
2. Add `dismissing` state and `handleDismissConflicts` callback sending `POST /project/${projectId}/google-drive/conflicts/dismiss`.
3. If `status.conflicts && status.conflicts.length > 0`, render a yellow warning alert box with conflict file list and a "Dismiss conflicts" button.
4. If `status.syncSuspended`, render an error alert box with `status.suspendReason` and disable/hide the "Sync now" button.

- [ ] **Step 4: Update frontend tests in `google-drive-modal.test.tsx`**

Add tests asserting:
1. Conflict banner renders when `conflicts` are present.
2. Clicking "Dismiss conflicts" sends the POST request.
3. Suspended banner renders when `syncSuspended` is true.

- [ ] **Step 5: Run unit and frontend tests**

Run:
`npx vitest run test/unit/src/Features/GoogleDriveSync/GoogleDriveController.test.mjs test/unit/src/Features/GoogleDriveSync/GoogleDriveRouter.test.mjs`
Expected: PASS.

- [ ] **Step 6: Stop and report**

Do not commit. Report and wait.

---

## Task 5: Full Suite Verification & Dev Server Validation

Verification gate for Phase 4 deliverable.

**Files:** none modified.

- [ ] **Step 1: Run full Google Drive backend test suite**

Run: `npx vitest run test/unit/src/Features/GoogleDriveSync/`
Expected: PASS, all test suites.

- [ ] **Step 2: Run neighbour test suites**

Run: `npx vitest run test/unit/src/infrastructure/ test/unit/src/Project/`
Expected: PASS.

- [ ] **Step 3: Run ESLint**

Run: `npx eslint app/src/Features/GoogleDriveSync/ test/unit/src/Features/GoogleDriveSync/`
Expected: 0 errors, 0 warnings.

- [ ] **Step 4: Stop and report**

Do not commit. Report to the user.
