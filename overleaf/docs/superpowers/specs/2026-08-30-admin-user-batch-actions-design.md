# Admin User Management: Batch Selection & Bulk Actions Design Spec

## Overview
This document specifies the design and implementation for batch user selection and multi-user bulk actions in the Overleaf Admin User Management module (`modules/admin-user-management`).

The feature adds standard row-level selection checkboxes and a responsive batch action banner to both the **Active Users** and **Deleted Users** tables, allowing site administrators to execute actions on multiple accounts simultaneously with safety guardrails and audit logging.

---

## 1. User Interface & Interaction Design

### 1.1 Persistent Search & Batch Banner Layout
The search input and **Add new users** button remain persistently visible at all times. When one or more users are selected ($\ge 1$), a dedicated **Batch Actions Bar** is displayed immediately above the table.

```
+-----------------------------------------------------------------------------------------------+
| [ Search users by name or email...              ]                        [ + Add new users ]  |
+-----------------------------------------------------------------------------------------------+
| ℹ️  3 users selected   [ Deselect All ]      | [ 🔒 Revoke Sessions ] [ 🗑️ Delete Selected ] |
+-----------------------------------------------------------------------------------------------+
| [ ] | Email                     | Name         | Role  | Registered | Last Active | Actions   |
| [x] | user1@example.com         | Alice Smith  | User  | 2026-08-01 | Yesterday   | [Manage ▼]|
| [x] | user2@example.com         | Bob Jones    | Admin | 2026-08-05 | 2026-08-12  | [Manage ▼]|
| [ ] | user3@example.com         | Charlie Park | User  | 2026-08-10 | Never       | [Manage ▼]|
+-----------------------------------------------------------------------------------------------+
```

### 1.2 Selection Mechanics
1. **Header Checkbox**:
   * **Unchecked**: 0 visible items on the current page are selected.
   * **Indeterminate (`-`)**: Some visible items on the current page are selected.
   * **Checked**: All visible items on the current page are selected.
   * Clicking the header checkbox toggles selection for all visible items on the active page.
2. **Row Checkboxes**:
   * Checking/unchecking a row updates the global selection set (`Set<string>` of user IDs or record IDs).
3. **Cross-Search Retention**:
   * Searching or filtering does **not** erase selections of users that become hidden by the search query.
   * Switching between the **Active Users** and **Deleted Users** tabs clears the selection to avoid cross-domain state conflicts.
4. **Deselect All Button**:
   * Clicking **Deselect All** clears all selected IDs and hides the batch action bar.

---

## 2. Supported Batch Actions

### 2.1 Active Users Tab
1. **Batch Revoke All Sessions**:
   * Iterates selected accounts and terminates all active Redis sessions.
   * If the currently logged-in administrator's account is among the selected, their active session is preserved (`retainSessionID`).
   * Logs `admin-revoked-sessions` in `UserAuditLogEntry` for each account.
2. **Batch Delete Accounts (Soft Delete)**:
   * Opens the **Batch Delete Confirmation Modal** displaying the count and list of selected email addresses.
   * Safely soft-deletes accounts via `UserDeleter.deleteUser`.
   * Automatically skips and protects the currently logged-in administrator from self-deletion.
   * Logs `admin-delete-user` in `UserAuditLogEntry` for each account.

### 2.2 Deleted Users Tab
1. **Batch Restore Accounts**:
   * Opens confirmation modal and invokes `AdminUserRestorer.restoreUserAccount` for each selected deleted user record.
   * Restores user accounts, emails, and project ownerships.
   * Logs `restore-account` in `UserAuditLogEntry` for each account.
2. **Batch Permanent Purge**:
   * Opens high-severity danger confirmation modal.
   * Permanently deletes `DeletedUser` records and cleans up metadata.

---

## 3. Backend Architecture & API Specifications

All batch endpoints are mounted under `AdminUserManagementRouter.mjs` with `RateLimiterMiddleware.rateLimit` and `AuthorizationMiddleware.ensureUserIsSiteAdmin`.

### 3.1 `POST /admin/users/api/users/batch-delete`
* **Request Body**: `{ userIds: string[] }`
* **Validation**:
  * `userIds` must be a non-empty array of valid MongoDB ObjectIds (max 100 per request).
  * Excludes caller's own user ID (`req.session.user._id`).
* **Behavior**: Soft-deletes each user via `UserDeleter`, appends audit trail entry.
* **Response**:
  ```json
  {
    "success": true,
    "deletedCount": 3,
    "skippedSelf": false,
    "failed": []
  }
  ```

### 3.2 `POST /admin/users/api/users/batch-revoke-sessions`
* **Request Body**: `{ userIds: string[] }`
* **Validation**: Non-empty array of valid ObjectIds.
* **Behavior**: Calls `UserSessionsManager.removeSessionsFromRedis` for each user.
* **Response**:
  ```json
  {
    "success": true,
    "totalRevoked": 5
  }
  ```

### 3.3 `POST /admin/users/api/users/batch-restore`
* **Request Body**: `{ userIds: string[] }`
* **Validation**: Non-empty array of valid user ObjectIds.
* **Behavior**: Restores accounts via `AdminUserRestorer.restoreUserAccount`.
* **Response**:
  ```json
  {
    "success": true,
    "restoredCount": 2,
    "restoredProjectsCount": 6,
    "failed": []
  }
  ```

### 3.4 `POST /admin/users/api/deleted-users/batch-purge`
* **Request Body**: `{ recordIds: string[] }`
* **Validation**: Non-empty array of valid deleted user record ObjectIds.
* **Behavior**: Deletes records from `DeletedUser` collection.
* **Response**:
  ```json
  {
    "success": true,
    "purgedCount": 2
  }
  ```

---

## 4. Frontend Component Structure

1. **`AdminUserListPage` (`admin-user-list-page.tsx`)**:
   * State:
     * `selectedActiveUsers: Map<string, ActiveUser>`
     * `selectedDeletedUsers: Map<string, DeletedUserRecord>`
     * `showBatchDeleteModal: boolean`
     * `showBatchRevokeModal: boolean`
     * `showBatchRestoreModal: boolean`
     * `showBatchPurgeModal: boolean`
   * Checkbox column with header indeterminate calculation:
     ```tsx
     const allVisibleSelected = visibleUsers.every(u => selectedActiveUsers.has(u._id))
     const someVisibleSelected = visibleUsers.some(u => selectedActiveUsers.has(u._id))
     ```
2. **`BatchActionBar` (`batch-action-bar.tsx`)**:
   * Modular component rendering the info banner with count badge, `Deselect All` link, and tab-specific action buttons.
3. **Batch Confirmation Modals**:
   * **`BatchDeleteUsersModal` (`batch-delete-users-modal.tsx`)**: Lists emails, retention warning, soft-delete confirmation.
   * **`BatchRevokeSessionsModal` (`batch-revoke-sessions-modal.tsx`)**: Lists selected accounts, warning about device sign-outs.
   * **`BatchRestoreUsersModal` (`batch-restore-users-modal.tsx`)**: Summary of accounts to be restored.
   * **`BatchPurgeUsersModal` (`batch-purge-users-modal.tsx`)**: Red danger warning for permanent account purging.

---

## 5. Security & Safeguards
* **Self-Action Prevention**: An administrator cannot batch-delete or lock out their own account.
* **Rate Limiting**: Protected with Overleaf's `RateLimiterMiddleware` (`points: 30, duration: 60`).
* **Audit Trail**: Every individual account operation within a batch request is recorded with timestamps, actor ID, and IP address in `UserAuditLogEntry`.

---

## 6. Testing & Verification Plan
* **Unit Tests**:
  * `AdminUserBatchActions.test.mjs`: Test validation, batch deletion, session revocation, batch restoration, and purge logic.
  * Router test suite updates in `AdminUserManagementRouter.test.mjs`.
* **Webpack Compilation**: Ensure zero compilation warnings or TypeScript errors.
* **E2E / Integration**: Execute automated verification scripts across all batch flows.
