# Admin User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native, modular Admin User Management subsystem for Overleaf Community Edition featuring searchable user directories, profile editing, administrator elevation, one-time password reset link generation, and soft-delete/restore for accounts and projects.

**Architecture:** Implemented as a standalone web module under `services/web/modules/admin-user-management/` registered dynamically via `Settings.moduleImportSequence`. It serves React-rendered pages at `/admin/users` and `/admin/users/:userId`, backed by dedicated REST API endpoints under `/admin/users/api/*` protected by `AuthorizationMiddleware.ensureUserIsSiteAdmin`.

**Tech Stack:** Node.js (ES Modules, TypeScript), Express, MongoDB (`mongodb` driver / Mongoose), React 18, Bootstrap 5 / Overleaf OL Components (`@/shared/components/ol/`), Vitest.

**Spec:** `overleaf/docs/superpowers/specs/2026-08-28-admin-user-management-design.md`

## Global Constraints

- Backend files must use ES Module syntax (`.mjs` or TypeScript `.mts`/`.ts`).
- All API mutations must be protected by `AuthorizationMiddleware.ensureUserIsSiteAdmin` and automatic CSRF verification.
- Sensitive credentials (`hashedPassword`, `twoFactorAuthentication.secretEncrypted`, `refProviders`) must never be returned in API projections.
- Module must be completely gated by `OVERLEAF_ADMIN_USER_MANAGEMENT_ENABLED` (default `false`).
- Unit tests run in sandbox via `/home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run <path>`.

---

## File Structure & Responsibilities

```
overleaf/
├── variable.env                                         # Deployment env var template (OVERLEAF_ADMIN_USER_MANAGEMENT_ENABLED)
├── server-ce/config/settings.js                         # Production container settings mapping
├── services/web/
│   ├── config/settings.defaults.js                     # Dev settings & moduleImportSequence registration
│   ├── app/src/infrastructure/Features.mjs              # Feature flag evaluator
│   ├── app/views/layout/navbar-marketing.pug            # Pug navbar: Manage Site, Manage Users, Register Users
│   ├── frontend/js/shared/components/navbar/
│   │   └── admin-menu.tsx                               # React navbar Admin dropdown menu
│   └── modules/admin-user-management/                   # Main feature module
│       ├── index.mjs                                    # Module entrypoint exporting { router }
│       ├── app/
│       │   ├── src/
│       │   │   ├── AdminUserQuery.mjs                   # Search, filter, pagination & whitelist projections
│       │   │   ├── AdminUserGuards.mjs                  # Self-demotion, self-deletion, last-admin invariants
│       │   │   ├── AdminUserRestorer.mjs                # Multi-collection account & project undelete engine
│       │   │   ├── AdminUserManagementController.mjs    # Express route handlers, input validation, responses
│       │   │   └── AdminUserManagementRouter.mjs        # Route table & rate-limiter definitions
│       │   └── views/
│       │       ├── user_list.pug                        # Pug shell extending layout-react (mounts user list)
│       │       └── user_detail.pug                      # Pug shell extending layout-react (mounts user detail)
│       ├── frontend/js/
│       │   ├── pages/
│       │   │   ├── admin-user-list.tsx                  # Webpack page entrypoint for /admin/users
│       │   │   └── admin-user-detail.tsx                # Webpack page entrypoint for /admin/users/:userId
│       │   └── components/
│       │       ├── admin-user-list-page.tsx             # User list directory, search bar, active/deleted tabs
│       │       ├── admin-user-detail-page.tsx           # User detail cards (profile, admin toggle, reset link, danger zone)
│       │       ├── user-status-badge.tsx                # Badges for Admin, Suspended, Active, Unconfirmed
│       │       ├── restore-user-modal.tsx               # Modal confirming account and project restoration
│       │       └── delete-user-modal.tsx                # Modal confirming account soft-deletion
│       └── test/unit/src/
│           ├── AdminUserQuery.test.mjs                  # Unit tests for query sanitization & projections
│           ├── AdminUserGuards.test.mjs                 # Unit tests for safety invariant guards
│           └── AdminUserRestorer.test.mjs               # Unit tests for restoration logic
```

---

### Task 1: Environment Variables & Feature Flag Configuration

**Files:**
- Modify: `overleaf/variable.env:21-25`
- Modify: `overleaf/server-ce/config/settings.js:58-65`
- Modify: `overleaf/services/web/config/settings.defaults.js:410-415, 1113-1120`
- Modify: `overleaf/services/web/app/src/infrastructure/Features.mjs:47-97`

**Interfaces:**
- Produces: `Settings.enableAdminUserManagement: boolean`, `Features.hasFeature('admin-user-management'): boolean`

- [x] **Step 1: Update `variable.env`**
Add the commented-out environment variable documentation to `overleaf/variable.env`:
```ini
# Enable Admin User Management UI and APIs in Overleaf Community Edition (default: false)
# OVERLEAF_ADMIN_USER_MANAGEMENT_ENABLED=true
```

- [x] **Step 2: Update `server-ce/config/settings.js`**
Add `enableAdminUserManagement` property reading `process.env.OVERLEAF_ADMIN_USER_MANAGEMENT_ENABLED === 'true'`.

- [x] **Step 3: Update `services/web/config/settings.defaults.js`**
Set `enableAdminUserManagement: process.env.OVERLEAF_ADMIN_USER_MANAGEMENT_ENABLED === 'true'` and add `'admin-user-management'` to `moduleImportSequence` immediately before `'user-activate'`.

- [x] **Step 4: Update `services/web/app/src/infrastructure/Features.mjs`**
Add case `'admin-user-management'` returning `Boolean(Settings.enableAdminUserManagement)`.

- [x] **Step 5: Verify configuration with a unit test**
Create a quick unit test verifying `Features.hasFeature('admin-user-management')` reflects `Settings.enableAdminUserManagement`.

---

### Task 2: Query & Projection Layer (`AdminUserQuery.mjs`)

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserQuery.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserQuery.test.mjs`

**Interfaces:**
- Produces:
  - `getActiveUsers({ search, page, limit, sortBy, sortOrder })`: Promise<{ users, total, page, totalPages }>
  - `getDeletedUsers({ search, page, limit })`: Promise<{ deletedUsers, total, page, totalPages }>
  - `getUserById(userId)`: Promise<UserDetail | null>
  - `USER_ADMIN_LIST_PROJECTION`, `DELETED_USER_ADMIN_LIST_PROJECTION`, `USER_DETAIL_PROJECTION`

- [x] **Step 1: Write the failing unit tests for query sanitization and projections**
Create `AdminUserQuery.test.mjs` testing:
1. `getActiveUsers` escapes regex characters (`.*+?^${}()|[]\\`) to prevent ReDoS.
2. `getActiveUsers` clamps search length to 100 chars.
3. Whitelist projections exclude `hashedPassword`, `twoFactorAuthentication`, `refProviders`.
4. Pagination calculations (`skip`, `totalPages`).

- [x] **Step 2: Run test to verify it fails**
Run: `/home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserQuery.test.mjs`
Expected: FAIL with "Cannot find module AdminUserQuery.mjs".

- [x] **Step 3: Implement `AdminUserQuery.mjs`**
Implement the safe MongoDB queries:
```javascript
import _ from 'lodash'
import { ObjectId } from 'mongodb'
import { db } from '../../../../app/src/infrastructure/mongodb.mjs'

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

export const USER_DETAIL_PROJECTION = {
  ...USER_ADMIN_LIST_PROJECTION,
  ace: 1,
  features: 1,
}

export async function getActiveUsers({
  search = '',
  page = 1,
  limit = 20,
  sortBy = 'signUpDate',
  sortOrder = 'desc',
} = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
  const safePage = Math.max(parseInt(page, 10) || 1, 1)
  const skip = (safePage - 1) * safeLimit

  const match = {}
  const trimmed = typeof search === 'string' ? search.trim().slice(0, 100) : ''
  if (trimmed) {
    const escaped = _.escapeRegExp(trimmed)
    const regex = new RegExp(escaped, 'i')
    match.$or = [
      { email: regex },
      { first_name: regex },
      { last_name: regex },
      { 'emails.email': regex },
    ]
    if (ObjectId.isValid(trimmed)) {
      match.$or.push({ _id: new ObjectId(trimmed) })
    }
  }

  const allowedSorts = ['signUpDate', 'lastActive', 'lastLoggedIn', 'email', 'first_name']
  const sortField = allowedSorts.includes(sortBy) ? sortBy : 'signUpDate'
  const sortDir = sortOrder === 'asc' ? 1 : -1
  const sortCriteria = { [sortField]: sortDir, _id: -1 }

  const [users, total] = await Promise.all([
    db.users.find(match, { projection: USER_ADMIN_LIST_PROJECTION })
      .sort(sortCriteria)
      .skip(skip)
      .limit(safeLimit)
      .toArray(),
    db.users.countDocuments(match),
  ])

  return {
    users,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  }
}

export async function getDeletedUsers({
  search = '',
  page = 1,
  limit = 20,
} = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
  const safePage = Math.max(parseInt(page, 10) || 1, 1)
  const skip = (safePage - 1) * safeLimit

  const match = {}
  const trimmed = typeof search === 'string' ? search.trim().slice(0, 100) : ''
  if (trimmed) {
    const escaped = _.escapeRegExp(trimmed)
    const regex = new RegExp(escaped, 'i')
    match.$or = [
      { 'user.email': regex },
      { 'user.first_name': regex },
      { 'user.last_name': regex },
      { 'user.emails.email': regex },
    ]
    if (ObjectId.isValid(trimmed)) {
      match.$or.push({ 'deleterData.deletedUserId': new ObjectId(trimmed) })
    }
  }

  const [deletedUsers, total] = await Promise.all([
    db.deletedUsers.find(match, { projection: DELETED_USER_ADMIN_LIST_PROJECTION })
      .sort({ 'deleterData.deletedAt': -1, _id: -1 })
      .skip(skip)
      .limit(safeLimit)
      .toArray(),
    db.deletedUsers.countDocuments(match),
  ])

  return {
    deletedUsers,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1,
  }
}

export async function getUserById(userId) {
  if (!ObjectId.isValid(userId)) return null
  return db.users.findOne(
    { _id: new ObjectId(userId) },
    { projection: USER_DETAIL_PROJECTION }
  )
}
```

- [x] **Step 4: Run test to verify it passes**
Run: `/home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserQuery.test.mjs`
Expected: PASS.

---

### Task 3: Invariant & Safety Guards (`AdminUserGuards.mjs`)

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserGuards.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserGuards.test.mjs`

**Interfaces:**
- Produces:
  - `ensureCanModifyAdmin(callerUserId, targetUserId, newIsAdmin)`
  - `ensureCanDeleteUser(callerUserId, targetUser)`

- [x] **Step 1: Write failing unit tests for safety guards**
Create `AdminUserGuards.test.mjs` verifying:
1. Self-demotion throws `BadRequestError('cannot_demote_self')`.
2. Self-deletion throws `BadRequestError('cannot_delete_self')`.
3. Modifying or deleting the sole remaining active admin throws `ForbiddenError('cannot_modify_last_admin')`.
4. Operations succeed when multiple active admins exist.

- [x] **Step 2: Run test to verify it fails**
Run: `/home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserGuards.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement `AdminUserGuards.mjs`**
```javascript
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import { db } from '../../../../app/src/infrastructure/mongodb.mjs'

export async function ensureCanModifyAdmin(callerUserId, targetUserId, newIsAdmin) {
  if (String(callerUserId) === String(targetUserId) && !newIsAdmin) {
    throw new Errors.BadRequestError('cannot_demote_self')
  }

  if (!newIsAdmin) {
    const activeAdminCount = await db.users.countDocuments({
      isAdmin: true,
      suspended: { $ne: true },
    })
    if (activeAdminCount <= 1) {
      throw new Errors.ForbiddenError('cannot_modify_last_admin')
    }
  }
}

export async function ensureCanDeleteUser(callerUserId, targetUser) {
  if (String(callerUserId) === String(targetUser._id)) {
    throw new Errors.BadRequestError('cannot_delete_self')
  }

  if (targetUser.isAdmin) {
    const activeAdminCount = await db.users.countDocuments({
      isAdmin: true,
      suspended: { $ne: true },
    })
    if (activeAdminCount <= 1) {
      throw new Errors.ForbiddenError('cannot_modify_last_admin')
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**
Run: `/home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserGuards.test.mjs`
Expected: PASS.

---

### Task 4: Account & Project Restoration Engine (`AdminUserRestorer.mjs`)

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserRestorer.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserRestorer.test.mjs`

**Interfaces:**
- Produces: `restoreUserAndProjects(userId, callerUserId, ipAddress)`: Promise<{ restoredUser, restoredProjectCount }>

- [x] **Step 1: Write failing unit test for user & project restoration**
Create `AdminUserRestorer.test.mjs` verifying:
1. Throws `NotFoundError('user_too_old_to_restore_or_not_found')` if deleted user record is missing or expired.
2. Throws `ConflictError('email_already_in_use_by_active_user')` if primary email is currently in use.
3. Re-inserts user into `db.users` and removes from `db.deletedUsers`.
4. Queries associated `deletedProjects` and executes `ProjectDeleter.undeleteProject`.
5. Emits audit log entry `admin-restore-user`.

- [x] **Step 2: Run test to verify it fails**
Run: `/home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserRestorer.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement `AdminUserRestorer.mjs`**
```javascript
import { ObjectId } from 'mongodb'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import ProjectDeleter from '../../../../app/src/Features/Project/ProjectDeleter.mjs'
import UserAuditLogHandler from '../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { db } from '../../../../app/src/infrastructure/mongodb.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import { DeletedUser } from '../../../../app/src/models/DeletedUser.mjs'
import { DeletedProject } from '../../../../app/src/models/DeletedProject.mjs'

export async function restoreUserAndProjects(userId, callerUserId, ipAddress) {
  const userObjectId = new ObjectId(userId)
  const deletedUser = await DeletedUser.findOne({
    'deleterData.deletedUserId': userObjectId,
  }).exec()

  if (!deletedUser || !deletedUser.user) {
    throw new Errors.NotFoundError('user_too_old_to_restore_or_not_found')
  }

  const existingActive = await UserGetter.promises.getUserByAnyEmail(
    deletedUser.user.email
  )
  if (existingActive) {
    throw new Errors.ConflictError('email_already_in_use_by_active_user')
  }

  // Native insert to preserve original _id and hashed credentials
  const restoredUser = new User(deletedUser.user)
  await db.users.insertOne(restoredUser)
  await DeletedUser.deleteOne({ _id: deletedUser._id }).exec()

  // Find associated soft-deleted projects
  const deletedProjects = await DeletedProject.find({
    'deleterData.deletedProjectOwnerId': userObjectId,
    'deleterData.deletedReason': 'account-deletion',
    project: { $type: 'object' },
  }).exec()

  for (const deletedProject of deletedProjects) {
    try {
      await ProjectDeleter.promises.undeleteProject(
        deletedProject.deleterData.deletedProjectId
      )
    } catch (err) {
      // Continue restoring other projects if one fails
    }
  }

  await UserAuditLogHandler.promises.addEntry(
    userObjectId,
    'admin-restore-user',
    callerUserId,
    ipAddress || '0.0.0.0',
    { restoredProjectCount: deletedProjects.length }
  )

  return {
    restoredUser,
    restoredProjectCount: deletedProjects.length,
  }
}
```

- [x] **Step 4: Run test to verify it passes**
Run: `/home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserRestorer.test.mjs`
Expected: PASS.

---

### Task 5: Controller, Router & Module Entrypoint

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`
- Create: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`
- Create: `overleaf/services/web/modules/admin-user-management/index.mjs`

**Interfaces:**
- Produces:
  - `AdminUserManagementRouter.apply(webRouter)`: Registers GET/POST routes and rate-limiters under `/admin/users*`
  - `AdminUserManagementModule`: `{ router: AdminUserManagementRouter }`

- [x] **Step 1: Implement `AdminUserManagementController.mjs`**
Handles input validation, invokes Query/Guards/Restorer, generates 7-day password reset tokens via `OneTimeTokenHandler`, soft-deletes via `UserDeleter.deleteUser`, and flushes Redis sessions on demotion via `UserSessionsManager`.

- [x] **Step 2: Implement `AdminUserManagementRouter.mjs`**
Applies `AuthorizationMiddleware.ensureUserIsSiteAdmin` on all `/admin/users*` routes. Defines rate-limiting (30 reqs/60s). Aliases `GET /admin/user` to `/admin/users`.

- [x] **Step 3: Implement `index.mjs`**
Exports `{ router: AdminUserManagementRouter }`.

- [x] **Step 4: Verify module loading with unit test**
Test router route registration and disabled feature redirect.

---

### Task 6: Top Navbar Navigation Updates

**Files:**
- Modify: `overleaf/services/web/app/views/layout/navbar-marketing.pug:65-72`
- Modify: `overleaf/services/web/frontend/js/shared/components/navbar/admin-menu.tsx:38-48`

**Interfaces:**
- Displays 3 dropdown items when `canDisplayAdminMenu` is true:
  1. "Manage Site" (`/admin`)
  2. "Manage Users" (`/admin/users`)
  3. "Register Users" (`/admin/register`)

- [x] **Step 1: Update `navbar-marketing.pug`**
```pug
if canDisplayAdminMenu
    +dropdown-menu-link-item(href='/admin') Manage Site
    +dropdown-menu-link-item(href='/admin/users') Manage Users
    +dropdown-menu-link-item(href='/admin/register') Register Users
```

- [x] **Step 2: Update `admin-menu.tsx`**
```tsx
{canDisplayAdminMenu ? (
  <>
    <NavDropdownLinkItem href="/admin">Manage Site</NavDropdownLinkItem>
    <NavDropdownLinkItem href="/admin/users">Manage Users</NavDropdownLinkItem>
    <NavDropdownLinkItem href="/admin/register">
      Register Users
    </NavDropdownLinkItem>
  </>
) : null}
```

---

### Task 7: Pug Views & Webpack Entrypoints

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/app/views/user_list.pug`
- Create: `overleaf/services/web/modules/admin-user-management/app/views/user_detail.pug`
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/pages/admin-user-list.tsx`
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/pages/admin-user-detail.tsx`

**Interfaces:**
- `user_list.pug` extends `../../../../app/views/layout-react`, entrypoint `modules/admin-user-management/pages/admin-user-list`
- `user_detail.pug` extends `../../../../app/views/layout-react`, entrypoint `modules/admin-user-management/pages/admin-user-detail`, meta `ol-target-user-id`

- [x] **Step 1: Create `user_list.pug`**
```pug
extends ../../../../app/views/layout-react

block entrypointVar
    - entrypoint = 'modules/admin-user-management/pages/admin-user-list'

block content
    #main-content.content.content-alt
        .container
            #admin-user-list-container
```

- [x] **Step 2: Create `user_detail.pug`**
```pug
extends ../../../../app/views/layout-react

block entrypointVar
    - entrypoint = 'modules/admin-user-management/pages/admin-user-detail'

block append meta
    meta(name='ol-target-user-id' content=targetUserId)

block content
    #main-content.content.content-alt
        .container
            #admin-user-detail-container
```

- [x] **Step 3: Create `admin-user-list.tsx` & `admin-user-detail.tsx`**
Mount React components into containers via `renderInReactLayout`.

---

### Task 8: React User List Components

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-list-page.tsx`
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/restore-user-modal.tsx`
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/user-status-badge.tsx`

**Interfaces:**
- Renders: Search bar with debounce, Active/Deleted tabs, table (`OLTable`), pagination, and restore modal.
- Calls: `getJSON('/admin/users/api/users')`, `getJSON('/admin/users/api/deleted-users')`, `postJSON('/admin/users/api/users/:userId/restore')`.

- [x] **Step 1: Implement `user-status-badge.tsx`**
Renders badges using `<OLBadge>` for Admin (`variant="primary"`), Suspended (`variant="danger"`), Active (`variant="success"`).

- [x] **Step 2: Implement `restore-user-modal.tsx`**
`<OLModal>` showing prompt: *"Restore this account and recover their associated projects from archive?"*, executing `postJSON`.

- [x] **Step 3: Implement `admin-user-list-page.tsx`**
Main directory component managing search state, pagination, active/deleted tab switching, and data fetching.

---

### Task 9: React User Detail Components

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-detail-page.tsx`
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/delete-user-modal.tsx`

**Interfaces:**
- Renders: Profile edit card, Site Admin toggle card, Password Reset card, Danger Zone card.
- Calls:
  - `getJSON('/admin/users/api/users/:userId')`
  - `postJSON('/admin/users/api/users/:userId/profile')`
  - `postJSON('/admin/users/api/users/:userId/admin')`
  - `postJSON('/admin/users/api/users/:userId/password-reset-link')`
  - `postJSON('/admin/users/api/users/:userId/delete')`

- [x] **Step 1: Implement `delete-user-modal.tsx`**
`<OLModal>` confirming soft-deletion of account and project archival.

- [x] **Step 2: Implement `admin-user-detail-page.tsx`**
Detail page component with form inputs, password reset link generator with copy-to-clipboard button, admin privilege switcher, and soft-delete/restore triggers.

---

### Task 10: End-to-End Verification & Documentation

**Files:**
- Review: `overleaf/README.md` / `variable.env`

- [x] **Step 1: Run all unit test suites**
Execute: `/home/dangdd/.npm/_npx/69c381f8ad94b576/node_modules/.bin/vitest run overleaf/services/web/modules/admin-user-management/test/unit/`
Verify all unit tests pass cleanly.

- [x] **Step 2: Verify code style & formatting**
Check imports, TypeScript types, and formatting across all created files.
