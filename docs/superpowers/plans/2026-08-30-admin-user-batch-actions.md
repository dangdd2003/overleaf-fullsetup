# Admin User Management: Batch Selection & Bulk Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement row-level selection checkboxes, a persistent search workflow, and multi-user bulk actions (Batch Delete, Batch Revoke Sessions, Batch Restore, and Batch Permanent Purge) with safety guardrails in the Overleaf Admin User Management module.

**Architecture:** Add dedicated transactional batch endpoints in `AdminUserManagementController.mjs` mounted via `AdminUserManagementRouter.mjs`. In the React frontend, introduce `BatchActionBar.tsx`, checkbox column headers with indeterminate state tracking, and dedicated batch confirmation modals.

**Tech Stack:** Node.js, Express, MongoDB/Mongoose, React 18, TypeScript, Vitest, Overleaf UI Design System (`OLFormCheckbox`, `OLButton`, `OLModal`, `OLTable`).

## Global Constraints
- Do NOT touch git commit or push directly (as per workspace rules).
- All changes must be strictly isolated within `overleaf/services/web/modules/admin-user-management/`.
- Ensure caller self-actions (deleting own account or locking oneself out) are strictly prevented.
- Every individual batch operation must be recorded in `UserAuditLogEntry`.

---

### Task 1: Backend Batch Delete & Batch Revoke Sessions Endpoints (TDD)

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBatchActive.test.mjs`
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBatchActive.test.mjs`

**Interfaces:**
- `AdminUserManagementController.batchDeleteUsers(req, res)`:
  - Consumes: `req.body.userIds: string[]`, `req.session.user._id: string`
  - Produces: `{ success: true, deletedCount: number, skippedSelf: boolean, failed: Array<{ userId: string, reason: string }> }`
- `AdminUserManagementController.batchRevokeUserSessions(req, res)`:
  - Consumes: `req.body.userIds: string[]`, `req.sessionID: string`, `req.session.user._id: string`
  - Produces: `{ success: true, totalRevoked: number, failed: Array<{ userId: string, reason: string }> }`

- [ ] **Step 1: Write failing unit test suite for batch active user operations**
Create `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBatchActive.test.mjs` testing:
- Validation: rejects missing or non-array `userIds` with 400.
- `batchDeleteUsers`: calls `UserDeleter.promises.deleteUser`, skips caller's own user ID, logs `admin-delete-user` audit entries, returns `{ success: true, deletedCount }`.
- `batchRevokeUserSessions`: calls `UserSessionsManager.removeSessionsFromRedis`, preserves caller's session when matching caller user ID, logs audit trail, returns `{ success: true, totalRevoked }`.

- [ ] **Step 2: Run tests to confirm RED state**
Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBatchActive.test.mjs`

- [ ] **Step 3: Implement `batchDeleteUsers` and `batchRevokeUserSessions` in Controller**
In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`:
- Validate all IDs via `ObjectId.isValid`.
- Filter out `callerUserId` in `batchDeleteUsers` so admins cannot delete themselves.
- Execute operations sequentially or via `Promise.allSettled` to prevent one failure from blocking remaining accounts.
- Append individual `UserAuditLogEntry` entries.

- [ ] **Step 4: Register routes in Router**
In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`:
- `POST /admin/users/api/users/batch-delete` -> `rateLimit`, `ensureUserIsSiteAdmin`, `AdminUserManagementController.batchDeleteUsers`
- `POST /admin/users/api/users/batch-revoke-sessions` -> `rateLimit`, `ensureUserIsSiteAdmin`, `AdminUserManagementController.batchRevokeUserSessions`

- [ ] **Step 5: Run unit tests to verify GREEN state**
Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBatchActive.test.mjs`

---

### Task 2: Backend Batch Restore & Batch Purge Endpoints (TDD)

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBatchDeleted.test.mjs`
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBatchDeleted.test.mjs`

**Interfaces:**
- `AdminUserManagementController.batchRestoreUsers(req, res)`:
  - Consumes: `req.body.userIds: string[]`
  - Produces: `{ success: true, restoredCount: number, restoredProjectsCount: number, failed: Array<{ userId: string, reason: string }> }`
- `AdminUserManagementController.batchPurgeDeletedUsers(req, res)`:
  - Consumes: `req.body.recordIds: string[]`
  - Produces: `{ success: true, purgedCount: number, failed: Array<{ recordId: string, reason: string }> }`

- [ ] **Step 1: Write failing unit test suite for batch deleted user operations**
Create `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBatchDeleted.test.mjs` testing:
- Validation: rejects missing or non-array inputs with 400.
- `batchRestoreUsers`: calls `AdminUserRestorer.restoreUserAccount`, logs audit trail, returns aggregate restored counts.
- `batchPurgeDeletedUsers`: deletes records from `DeletedUser` model, returns `{ success: true, purgedCount }`.

- [ ] **Step 2: Run tests to confirm RED state**
Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBatchDeleted.test.mjs`

- [ ] **Step 3: Implement `batchRestoreUsers` and `batchPurgeDeletedUsers` in Controller**
In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`:
- Validate IDs via `ObjectId.isValid`.
- Invoke `AdminUserRestorer.restoreUserAccount` for each user and tally restored projects.
- Invoke `DeletedUser.deleteMany({ _id: { $in: recordIds } })` (or sequential delete with safety checks).

- [ ] **Step 4: Register routes in Router**
In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`:
- `POST /admin/users/api/users/batch-restore` -> `rateLimit`, `ensureUserIsSiteAdmin`, `AdminUserManagementController.batchRestoreUsers`
- `POST /admin/users/api/deleted-users/batch-purge` -> `rateLimit`, `ensureUserIsSiteAdmin`, `AdminUserManagementController.batchPurgeDeletedUsers`

- [ ] **Step 5: Run unit tests to verify GREEN state**
Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBatchDeleted.test.mjs`

---

### Task 3: Batch Confirmation Modals (Frontend)

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/batch-delete-users-modal.tsx`
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/batch-revoke-sessions-modal.tsx`
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/batch-restore-users-modal.tsx`
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/batch-purge-users-modal.tsx`

**Interfaces:**
- `BatchDeleteUsersModal`: `show: boolean, users: ActiveUser[], onHide: () => void, onSuccess: (deletedCount: number) => void`
- `BatchRevokeSessionsModal`: `show: boolean, users: ActiveUser[], onHide: () => void, onSuccess: (revokedCount: number) => void`
- `BatchRestoreUsersModal`: `show: boolean, records: DeletedUserRecord[], onHide: () => void, onSuccess: (restoredCount: number, projectsCount: number) => void`
- `BatchPurgeUsersModal`: `show: boolean, records: DeletedUserRecord[], onHide: () => void, onSuccess: (purgedCount: number) => void`

- [ ] **Step 1: Create `BatchDeleteUsersModal`**
Renders list of selected user emails in a scrollable container with a 90-day retention notice and dispatch to `POST /admin/users/api/users/batch-delete`.

- [ ] **Step 2: Create `BatchRevokeSessionsModal`**
Renders list of selected accounts with a security warning and dispatch to `POST /admin/users/api/users/batch-revoke-sessions`.

- [ ] **Step 3: Create `BatchRestoreUsersModal`**
Renders account list and dispatch to `POST /admin/users/api/users/batch-restore`.

- [ ] **Step 4: Create `BatchPurgeUsersModal`**
Renders high-contrast danger modal with confirmation step and dispatch to `POST /admin/users/api/deleted-users/batch-purge`.

---

### Task 4: BatchActionBar & Table Checkbox Selection Integration (Frontend)

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/batch-action-bar.tsx`
- Modify: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-list-page.tsx`

**Interfaces:**
- `BatchActionBar`:
  - Props: `selectedCount: number, tab: 'active' | 'deleted', onDeselectAll: () => void, onRevokeSessions: () => void, onDelete: () => void, onRestore: () => void, onPurge: () => void`

- [ ] **Step 1: Create `BatchActionBar` component**
Renders a clean banner with `OLBadge`, `Deselect All` button, and tab-specific action buttons (`Revoke Sessions`, `Delete`, `Restore`, `Purge`).

- [ ] **Step 2: Add selection state and checkbox column in `AdminUserListPage`**
In `admin-user-list-page.tsx`:
- Add `selectedActiveUsers: Map<string, ActiveUser>` and `selectedDeletedUsers: Map<string, DeletedUserRecord>`.
- Add first column `style={{ width: '48px' }}` with `OLFormCheckbox`.
- Implement header `OLFormCheckbox` with `indeterminate` ref logic matching `project-list-table.tsx`.
- Keep search input persistent across selections.
- Mount `BatchActionBar` right above the table when `selectedCount > 0`.
- Mount all 4 batch modals at the bottom of the page.

- [ ] **Step 3: Verify Webpack compilation**
Run: `docker compose logs --tail=10 webpack` in `overleaf/develop` and verify 0 errors.

---

### Task 5: End-to-End Verification & Full Test Suite

**Files:**
- Run all test suites across the module

- [ ] **Step 1: Run complete Vitest suite**
Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/`
Verify all unit tests pass (100% green).

- [ ] **Step 2: Verify Webpack compilation**
Run: `docker compose logs --tail=10 webpack` in `overleaf/develop`.

- [ ] **Step 3: Manual / Automated Flow Confirmation**
Confirm that batch selecting, deselecting, searching while selected, and executing each batch action works smoothly without layout distortion or unexpected regressions.
