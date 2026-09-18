# Design Specification: Admin User Management for Overleaf Community Edition

**Date**: 2026-08-28  
**Status**: Approved / Ready for Implementation Planning  
**Target**: Overleaf Community Edition (Server CE)

---

## 1. Overview & Goals

In standard Overleaf Community Edition (CE), the Admin Portal is limited to System Messages, Open Sockets, and Open/Close Editor controls (`/admin`). The legacy user route `/admin/user` simply redirects to `/admin/register` (`modules/user-activate`), providing only an email invitation form. Full graphical user management (viewing all users, search, profile editing, administrator elevation, password reset generation, and soft-delete/restore) is historically restricted to Overleaf Server Pro.

This specification designs a native, self-contained **Admin User Management** subsystem for Overleaf Community Edition. It provides an intuitive web interface for instance administrators to manage user accounts while adhering strictly to Overleaf's modular service architecture and RESTful routing conventions.

### Primary Goals
1. **User Discovery & Overview**: Provide a paginated, searchable listing of active and soft-deleted accounts at `/admin/users`.
2. **User Details & Profile Management**: Provide a dedicated user management page at `/admin/users/:userId` to view registration metadata, update names, inspect confirmed emails, and manage instance administrative privileges.
3. **Dedicated Navbar Entrypoints**: Update the top **Admin ▾** navigation dropdown to clearly separate **"Manage Site"** (`/admin`), **"Manage Users"** (`/admin/users`), and **"Register Users"** (`/admin/register`).
4. **Password Management**: Generate one-time password reset URLs (valid for 7 days) directly from the admin panel for easy user onboarding or recovery in internal-account deployments.
5. **Soft Delete & Full Restoration**: Provide safe soft-deletion of user accounts that preserves data integrity, paired with a full restoration mechanism that recovers both the user account and their soft-deleted projects from `deletedProjects`.
6. **Safety Guards**: Enforce strict invariants protecting against self-demotion, self-deletion, and removal of the instance's last remaining active administrator.
7. **Configurable Feature Gating**: Ensure the entire subsystem can be cleanly enabled or disabled via standard environment variables (`OVERLEAF_ADMIN_USER_MANAGEMENT_ENABLED`) across backend and frontend.

---

## 2. Navigation & User Interface Flow

### 2.1 The **Admin ▾** Dropdown Menu
When an administrator logs in, the navbar **Admin ▾** menu (`admin-menu.tsx` and `navbar-marketing.pug`) renders three primary destinations:

```
[ Overleaf Logo ]                                       [ Admin ▾ ] [ Account ▾ ]
                                                        +-----------------------------------+
                                                        | Manage Site    (/admin)           |
                                                        | Manage Users   (/admin/users)     | <--- User List & Search
                                                        | Register Users (/admin/register)  | <--- Email Invite Form
                                                        +-----------------------------------+
```

* **Manage Site (`/admin`)**: System announcements, open socket monitoring, and open/close editor maintenance controls.
* **Manage Users (`/admin/users`)**: Complete user directory, search bar, active vs. deleted user filters, pagination, and links to user detail management.
* **Register Users (`/admin/register`)**: Batch email registration form to invite new users and view initial activation URLs.

---

## 3. System Architecture & Module Structure

The feature is implemented as a standalone web module located at `overleaf/services/web/modules/admin-user-management/`. This follows the monorepo's modularization pattern (similar to `user-activate` and `launchpad`), keeping core code untouched and allowing the feature to be enabled/disabled via `Settings.moduleImportSequence`.

```
overleaf/services/web/modules/admin-user-management/
├── index.mjs                                    # Module entry exporting { router: AdminUserManagementRouter }
├── app/
│   ├── src/
│   │   ├── AdminUserManagementRouter.mjs        # Route table, auth middleware, and rate limits
│   │   ├── AdminUserManagementController.mjs    # HTTP handlers, validation, error mapping
│   │   ├── AdminUserQuery.mjs                   # Search, filter, sorting, and pagination queries
│   │   ├── AdminUserRestorer.mjs                # Multi-collection account & project undelete logic
│   │   └── AdminUserGuards.mjs                  # Self-harm and last-admin invariant validators
│   └── views/
│       ├── user_list.pug                        # Pug shell extending layout-react (mounts admin-user-list)
│       └── user_detail.pug                      # Pug shell extending layout-react (mounts admin-user-detail)
└── frontend/
    └── js/
        ├── pages/
        │   ├── admin-user-list.tsx              # Webpack page entrypoint for /admin/users
        │   └── admin-user-detail.tsx            # Webpack page entrypoint for /admin/users/:userId
        └── components/
            ├── admin-user-list-page.tsx         # Main user table, search, filters, pagination
            ├── admin-user-detail-page.tsx       # Detail view with profile, admin toggle, password reset
            ├── restore-user-modal.tsx           # Confirmation modal for account & project recovery
            └── delete-user-modal.tsx            # Confirmation modal for account soft-deletion
```

### Module Registration & Router Priority
In `overleaf/services/web/config/settings.defaults.js`, `admin-user-management` is placed in `moduleImportSequence` immediately **before** `user-activate`:

```javascript
moduleImportSequence: [
  'history-v1',
  'launchpad',
  'server-ce-scripts',
  'admin-user-management',
  'user-activate',
]
```

Because Express evaluates router middleware in the order registered by `Modules.mjs`:
- When `enableAdminUserManagement` is **true**: `AdminUserManagementRouter` handles `GET /admin/users` and `/admin/users/:userId`, and provides a redirect from `/admin/user` $\rightarrow$ `/admin/users` for backwards compatibility.
- When `enableAdminUserManagement` is **false**: `AdminUserManagementRouter` falls back to redirecting `/admin/user` and `/admin/users` to `/admin/register`.

---

## 4. Data Models, Queries & Indexes

### 4.1 MongoDB Collections Used
1. **`users` (`db.users` / `User.mjs`)**: Active user documents. Contains `email`, `emails[]`, `first_name`, `last_name`, `isAdmin`, `signUpDate`, `lastActive`, `lastLoggedIn`, `loginCount`, `suspended`.
2. **`deletedUsers` (`db.deletedUsers` / `DeletedUser.mjs`)**: Stores soft-deleted user snapshots under the `user` field, alongside deletion metadata in `deleterData` (`deletedAt`, `deleterId`, `deletedUserId`).
3. **`deletedProjects` (`db.deletedProjects` / `DeletedProject.mjs`)**: Stores soft-deleted projects associated with account deletions (`deleterData.deletedProjectOwnerId`, `deleterData.deletedReason = 'account-deletion'`).
4. **`userAuditLogEntries` (`db.userAuditLogEntries` / `UserAuditLogEntry.mjs`)**: Records immutable audit events for all administrative mutations.
5. **`tokens` (`db.tokens` / `OneTimeTokenHandler.mjs`)**: Stores one-time cryptographically secure password reset tokens.

### 4.2 Projections & Credential Safety
Raw user documents contain sensitive authentication secrets (`hashedPassword`, `twoFactorAuthentication.secretEncrypted`, OAuth refresh tokens in `refProviders`). The API must **never** return unprojected user objects.

#### Whitelist Projection for User Listing:
```javascript
export const USER_ADMIN_LIST_PROJECTION = {
  _id: 1,
  email: 1,
  'emails.email': 1,
  'emails.confirmedAt': 1,
  'emails.createdAt': 1,
  first_name: 1,
  last_name: 1,
  isAdmin: 1,
  signUpDate: 1,
  lastActive: 1,
  lastLoggedIn: 1,
  loginCount: 1,
  holdingAccount: 1,
  suspended: 1,
  role: 1,
  institution: 1,
}
```

#### Whitelist Projection for Deleted Users:
```javascript
export const DELETED_USER_ADMIN_LIST_PROJECTION = {
  _id: 1,
  deleterData: 1,
  'user._id': 1,
  'user.email': 1,
  'user.first_name': 1,
  'user.last_name': 1,
  'user.signUpDate': 1,
  'user.lastLoggedIn': 1,
  'user.isAdmin': 1,
}
```

### 4.3 Search Query Construction (`AdminUserQuery.mjs`)
- **Sanitization**: Input strings are truncated to 100 characters and escaped via `_.escapeRegExp` to prevent ReDoS.
- **Regex Query**: An unanchored, case-insensitive regular expression matches against primary email, first name, last name, and secondary emails:
  ```javascript
  const sanitized = _.escapeRegExp(search.trim().slice(0, 100))
  const regex = new RegExp(sanitized, 'i')
  const match = {
    $or: [
      { email: regex },
      { first_name: regex },
      { last_name: regex },
      { 'emails.email': regex },
    ]
  }
  if (ObjectId.isValid(search.trim())) {
    match.$or.push({ _id: new ObjectId(search.trim()) })
  }
  ```
- **Performance Note**: `email` has a unique B-Tree index, but `first_name` and `last_name` are unindexed. In Overleaf CE installations (typically <10,000 users), a full collection scan takes <10ms and avoids schema migration overhead.

---

## 5. API Endpoints Specification

All routes are mounted on `webRouter` under `/admin/users` and require `AuthorizationMiddleware.ensureUserIsSiteAdmin`. CSRF protection is automatically enforced.

| Method | Endpoint | Description | Request Payload | Response |
|---|---|---|---|---|
| `GET` | `/admin/user` | Legacy route redirect to `/admin/users` | None | HTTP 302 Redirect |
| `GET` | `/admin/users` | Serves HTML page for user directory | None | `text/html` (Pug + React) |
| `GET` | `/admin/users/:userId` | Serves HTML page for user details | None | `text/html` (Pug + React) |
| `GET` | `/admin/users/api/users` | List & search active users | Query: `search`, `page`, `limit`, `sortBy`, `sortOrder` | `{ users: User[], total: number, page: number, totalPages: number }` |
| `GET` | `/admin/users/api/deleted-users` | List & search deleted users | Query: `search`, `page`, `limit` | `{ deletedUsers: DeletedUser[], total: number, page: number, totalPages: number }` |
| `GET` | `/admin/users/api/users/:userId` | Fetch detailed user information | None | `{ user: UserDetail }` |
| `POST` | `/admin/users/api/users/:userId/profile` | Update first name and last name | `{ first_name: string, last_name: string }` | `{ success: true, user: UserDetail }` |
| `POST` | `/admin/users/api/users/:userId/admin` | Toggle site administrator privileges | `{ isAdmin: boolean }` | `{ success: true, isAdmin: boolean }` |
| `POST` | `/admin/users/api/users/:userId/password-reset-link` | Generate 7-day one-time password reset URL | None | `{ resetUrl: string, expiresAt: string }` |
| `POST` | `/admin/users/api/users/:userId/delete` | Soft delete user account and projects | None | `{ success: true }` |
| `POST` | `/admin/users/api/users/:userId/restore` | Restore soft-deleted account and projects | None | `{ success: true, restoredProjectCount: number }` |

---

## 6. Security Guards & Business Logic

### 6.1 Invariant Validation (`AdminUserGuards.mjs`)
1. **Session Caller Identification**: Admin user ID is extracted using `SessionManager.getLoggedInUserId(req.session)` (compatible with all session backends).
2. **Self-Demotion Prevention**:
   ```javascript
   if (String(targetUserId) === String(callerUserId) && !newIsAdmin) {
     throw new Errors.BadRequestError('cannot_demote_self')
   }
   ```
3. **Self-Deletion Prevention**:
   ```javascript
   if (String(targetUserId) === String(callerUserId)) {
     throw new Errors.BadRequestError('cannot_delete_self')
   }
   ```
4. **Last-Admin Invariant**:
   ```javascript
   if (targetUser.isAdmin && (!newIsAdmin || isDeleting)) {
     const activeAdminCount = await db.users.countDocuments({
       isAdmin: true,
       suspended: { $ne: true }
     })
     if (activeAdminCount <= 1) {
       throw new Errors.ForbiddenError('cannot_modify_last_admin')
     }
   }
   ```
5. **Session Invalidation on Demotion**:
   When revoking site admin privileges, the target user's active sessions in Redis must be immediately flushed to prevent cached session privilege escalation:
   ```javascript
   await UserSessionsManager.promises.removeSessionsFromRedis({ _id: targetUserId })
   ```

### 6.2 Password Reset Token Generation
Password reset links are created server-side via `OneTimeTokenHandler`:
```javascript
const ONE_WEEK_IN_SECONDS = 7 * 24 * 60 * 60
const token = await OneTimeTokenHandler.promises.getNewToken(
  'password',
  { user_id: user._id.toString(), email: user.email },
  { expiresIn: ONE_WEEK_IN_SECONDS }
)
const resetUrl = `${Settings.siteUrl}/user/password/set?passwordResetToken=${token}&email=${encodeURIComponent(user.email)}`
```

### 6.3 Soft-Deletion Sequence
When `POST /admin/users/api/users/:userId/delete` is called:
1. Run safety guards (`ensureCanDeleteAdmin`).
2. Invoke existing core service `UserDeleter.promises.deleteUser(userId, { ipAddress: req.ip, deleterUser: callerUser, skipEmail: true })`.
3. `UserDeleter` automatically:
   - Records audit event `delete-account`.
   - Clears Redis sessions via `UserSessionsManager`.
   - Upserts full snapshot to `deletedUsers`.
   - Cascades project deletions to `deletedProjects` via `ProjectDeleter.deleteUsersProjects` with `deletedReason = 'account-deletion'`.
   - Removes user document from `users` collection.

### 6.4 Account & Project Restoration Flow (`AdminUserRestorer.mjs`)
1. **Lookup**: Query `DeletedUser.findOne({ 'deleterData.deletedUserId': new ObjectId(userId) })`. If missing or `!deletedUser.user`, return 404 (`user_too_old_to_restore`).
2. **Uniqueness Check**: Check `UserGetter.promises.getUserByAnyEmail(deletedUser.user.email)`. If an active account exists with the same primary or secondary email, return 409 (`email_already_in_use_by_active_user`).
3. **User Re-insertion**: Direct native insert into MongoDB to preserve original `_id` and password hash:
   ```javascript
   const restoredUser = new User(deletedUser.user)
   await db.users.insertOne(restoredUser)
   await DeletedUser.deleteOne({ _id: deletedUser._id })
   ```
4. **Project Restoration**: Query all associated projects from `deletedProjects`:
   ```javascript
   const deletedProjects = await DeletedProject.find({
     'deleterData.deletedProjectOwnerId': new ObjectId(userId),
     'deleterData.deletedReason': 'account-deletion',
     project: { $type: 'object' }
   }).exec()

   for (const deletedProject of deletedProjects) {
     await ProjectDeleter.promises.undeleteProject(
       deletedProject.deleterData.deletedProjectId
     )
   }
   ```
5. **Audit Logging**:
   ```javascript
   await UserAuditLogHandler.promises.addEntry(
     userId,
     'admin-restore-user',
     callerUserId,
     req.ip,
     { restoredProjectCount: deletedProjects.length }
   )
   ```

---

## 7. Frontend Architecture & User Experience

### 7.1 Layout & Component Structure
The UI utilizes Overleaf's standard React design system (`@/shared/components/ol/`) and Bootstrap 5 styles.

#### 1. User List View (`AdminUserListPage`)
* **Breadcrumb & Header**: Title "Manage Users", user counter, and an **"Add new users"** primary button linking to `/admin/register`.
* **Toolbar**:
  * Search bar with 300ms debounce matching email and name.
  * Status segment toggle: **"Active Users"** vs. **"Deleted Users"**.
  * Per-page selector (20, 50, 100).
* **Table (`OLTable`)**:
  * Columns (Active): Email, Name, Role (Admin badge / User), Registration Date, Last Active, Action ("Manage" button).
  * Columns (Deleted): Email, Name, Deleted At, Action ("Restore Account & Projects" button).
* **Pagination**: Standard `@/shared/components/pagination.jsx`.

#### 2. User Detail View (`AdminUserDetailPage`)
* **Header**: Breadcrumb `← Back to user list`, User's primary email, full name, and badges (`Admin`, `Active`, `Suspended`).
* **Card 1 — Profile Information**:
  * Editable fields: First Name, Last Name.
  * Read-only info: Primary Email, Secondary Emails with confirmation badges, Account Created Date, Last Login Timestamp.
  * "Save Profile" action.
* **Card 2 — Site Administrator Permissions**:
  * Toggle: `[x] Is Site Admin`.
  * Contextual explanation of permissions.
  * "Update Permissions" button with confirmation modal when demoting.
* **Card 3 — Password Management**:
  * Action: "Generate Password Reset Link".
  * Displays read-only text box with one-time URL and "Copy Link" button.
* **Card 4 — Danger Zone**:
  * Active User: "Delete User Account" button (opens confirmation modal explaining soft-delete and project archival).
  * Soft-Deleted User: "Restore Account & Projects" button.

---

## 8. Configuration & Environment Variables

### 8.1 Variable Definition
| Variable | Default | Scope | Description |
|---|---|---|---|
| `OVERLEAF_ADMIN_USER_MANAGEMENT_ENABLED` | `false` | Backend & Docker | Master switch to enable or disable the admin user management module. |

### 8.2 Configuration Mapping
1. **`overleaf/variable.env`**:
   ```ini
   # Enable Admin User Management UI and APIs in Overleaf Community Edition
   # OVERLEAF_ADMIN_USER_MANAGEMENT_ENABLED=true
   ```
2. **`overleaf/server-ce/config/settings.js`**:
   ```javascript
   enableAdminUserManagement:
     process.env.OVERLEAF_ADMIN_USER_MANAGEMENT_ENABLED === 'true',
   ```
3. **`overleaf/services/web/config/settings.defaults.js`**:
   ```javascript
   enableAdminUserManagement:
     process.env.OVERLEAF_ADMIN_USER_MANAGEMENT_ENABLED === 'true',
   ```
4. **`overleaf/services/web/app/src/infrastructure/Features.mjs`**:
   ```javascript
   case 'admin-user-management':
     return Boolean(Settings.enableAdminUserManagement)
   ```

---

## 9. Error Handling & Edge Cases

| Scenario | Handled By | Response / Behavior |
|---|---|---|
| Admin attempts to demote own account | `AdminUserGuards.mjs` | HTTP 400 (`cannot_demote_self`). UI displays error alert. |
| Admin attempts to delete own account | `AdminUserGuards.mjs` | HTTP 400 (`cannot_delete_self`). UI disables button for self. |
| Admin attempts to demote/delete last remaining admin | `AdminUserGuards.mjs` | HTTP 403 (`cannot_modify_last_admin`). Prevents instance lockout. |
| Restoring user whose email was re-registered | `AdminUserRestorer.mjs` | HTTP 409 (`email_already_in_use_by_active_user`). Explains collision to admin. |
| Restoring user past retention period (`user` purged) | `AdminUserRestorer.mjs` | HTTP 404 (`user_too_old_to_restore`). |
| Non-admin accesses any `/admin/users*` route | `AuthorizationMiddleware` | Redirects to `/restricted` or returns HTTP 403. |
| Search contains regex control characters | `AdminUserQuery.mjs` | Escaped with `_.escapeRegExp`; searches for literal characters. |
| User password reset link peeking | `OneTimeTokenHandler` | Allows up to 4 preview peeks before token consumption. |

---

## 10. Testing & Verification Plan

### 10.1 Unit & Service Tests (`modules/admin-user-management/test/unit/`)
* **`AdminUserQuery.test.mjs`**:
  * Test active user listing with pagination.
  * Test case-insensitive search by email, first name, last name.
  * Test regex escaping against injection strings (`.*+?^${}()`).
  * Verify sensitive fields (`hashedPassword`, `twoFactorAuthentication`) are omitted in query projections.
* **`AdminUserGuards.test.mjs`**:
  * Verify rejection of self-demotion and self-deletion.
  * Verify rejection when modifying the sole remaining site admin.
  * Verify successful passage when multiple admins exist.
* **`AdminUserRestorer.test.mjs`**:
  * Test user restoration with project re-attachment.
  * Test email collision detection on restore.
  * Test handling of expired/purged deleted records.

### 10.2 Acceptance & Integration Tests (`modules/admin-user-management/test/acceptance/`)
* **`AdminUserManagementApiTests.mjs`**:
  * End-to-end API test verifying non-admin access is blocked.
  * Admin updates target user's first/last name and verifies database persistence.
  * Admin elevates regular user to site admin, tests Redis session flush.
  * Admin soft-deletes a user with projects, checks `deletedUsers` and `deletedProjects`.
  * Admin restores the user and verifies projects reappear in active database.
  * Password reset link generation returns valid URL containing token.
