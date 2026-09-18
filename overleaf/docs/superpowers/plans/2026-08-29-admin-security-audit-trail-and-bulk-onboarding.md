# Phase 3: Security Audit Trail & Single/Bulk User Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the User Security Audit Trail timeline on the User Detail page and the Single/Bulk User Creation modal with direct CSV import and credential management on the main directory page.

**Architecture:** Extend `AdminUserManagementRouter.mjs` and `AdminUserManagementController.mjs` with endpoints for querying `UserAuditLogEntry` and batch-creating users via `UserCreator`, `AuthenticationManager`, and `OneTimeTokenHandler`. On the frontend, build `AdminUserAuditTrailCard` for `/admin/users/:userId` and `CreateUsersModal` for `/admin/users`.

**Tech Stack:** Node.js (ESM), Express 4, MongoDB (`UserAuditLogEntry`, `User`, `OneTimeToken`), React 18, TypeScript, Vitest, Bootstrap 5 / Overleaf Design Tokens.

## Global Constraints

- **Directory Boundary**: All new backend logic and frontend components MUST be placed inside `overleaf/services/web/modules/admin-user-management/`.
- **Password Security**: Passwords MUST be hashed via `AuthenticationManager.hashPassword` (bcrypt) before saving; never stored in plaintext.
- **Non-Blocking Bulk Import**: Invalid or duplicate rows MUST NOT fail the entire batch; append to `skipped` or `failed` lists.
- **Authorization**: All endpoints MUST require `AuthorizationMiddleware.ensureUserIsSiteAdmin` and mutation endpoints MUST be rate-limited.
- **Git Rules**: Never run `git commit` or `git push` directly in automation; provide clean commands for the user.

---

### Task 1: User Security Audit Trail Query Backend Endpoint

**Files:**
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserAuditTrail.test.mjs`

**Interfaces:**
- `AdminUserManagementController.getUserAuditLogs(req, res)`:
  - Query: `page`, `limit`
  - Output: `200 { auditLogs: [{ _id, operation, initiatorId, ipAddress, info, createdAt }], total, page, totalPages }`

- [ ] **Step 1: Write failing unit test for audit logs query**

Create `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserAuditTrail.test.mjs`:
```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminUserManagementController from '../../../../app/src/AdminUserManagementController.mjs'
import { UserAuditLogEntry } from '../../../../../../app/src/models/UserAuditLogEntry.mjs'

vi.mock('../../../../../../app/src/models/UserAuditLogEntry.mjs', () => ({
  UserAuditLogEntry: {
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
}))

describe('AdminUserAuditTrail Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getUserAuditLogs returns paginated audit log entries', async () => {
    const mockQuery = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        {
          _id: 'entry1',
          operation: 'admin-set-admin-status',
          initiatorId: 'admin1',
          ipAddress: '127.0.0.1',
          info: { isAdmin: true },
          createdAt: new Date('2026-08-29T10:00:00Z'),
        },
      ]),
    }
    UserAuditLogEntry.find.mockReturnValue(mockQuery)
    UserAuditLogEntry.countDocuments.mockResolvedValue(1)

    const req = {
      params: { userId: '6a929d69c5fd734cf2a08f76' },
      query: { page: '1', limit: '10' },
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.getUserAuditLogs(req, res)

    expect(res.json).toHaveBeenCalledWith({
      auditLogs: [
        expect.objectContaining({
          _id: 'entry1',
          operation: 'admin-set-admin-status',
        }),
      ],
      total: 1,
      page: 1,
      totalPages: 1,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserAuditTrail.test.mjs`
Expected: FAIL with `getUserAuditLogs is not a function`.

- [ ] **Step 3: Implement controller and router methods**

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`:
```javascript
import { UserAuditLogEntry } from '../../../../app/src/models/UserAuditLogEntry.mjs'

// Inside controller:
  async getUserAuditLogs(req, res) {
    try {
      const { userId } = req.params
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1)
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10))

      const matchQuery = { userId: new ObjectId(userId) }
      const [entries, total] = await Promise.all([
        UserAuditLogEntry.find(matchQuery)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        UserAuditLogEntry.countDocuments(matchQuery),
      ])

      return res.json({
        auditLogs: entries || [],
        total,
        page,
        totalPages: Math.ceil(total / limit) || 1,
      })
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'error getting user audit logs')
      return res.status(500).json({ error: 'failed_to_get_audit_logs' })
    }
  },
```

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`:
```javascript
    webRouter.get(
      '/admin/users/api/users/:userId/audit-logs',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.getUserAuditLogs
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserAuditTrail.test.mjs`
Expected: PASS.

---

### Task 2: Single & Bulk User Creation Backend Endpoint

**Files:**
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBulkCreate.test.mjs`

**Interfaces:**
- `AdminUserManagementController.bulkCreateUsers(req, res)`:
  - Body: `{ users: [{ email, first_name, last_name, password, isAdmin }] }`
  - Output: `200 { success: true, summary: { total, createdCount, skippedCount, failedCount }, created: [...], skipped: [...], failed: [...] }`

- [ ] **Step 1: Write failing unit test for bulk user creation**

Create `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBulkCreate.test.mjs`:
```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminUserManagementController from '../../../../app/src/AdminUserManagementController.mjs'
import UserGetter from '../../../../../../app/src/Features/User/UserGetter.mjs'
import UserCreator from '../../../../../../app/src/Features/User/UserCreator.mjs'
import AuthenticationManager from '../../../../../../app/src/Features/Authentication/AuthenticationManager.mjs'
import OneTimeTokenHandler from '../../../../../../app/src/Features/Security/OneTimeTokenHandler.mjs'
import { User } from '../../../../../../app/src/models/User.mjs'

vi.mock('../../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: {
    promises: {
      getUserByAnyEmail: vi.fn(),
    },
  },
}))

vi.mock('../../../../../../app/src/Features/User/UserCreator.mjs', () => ({
  default: {
    promises: {
      createNewUser: vi.fn(),
    },
  },
}))

vi.mock('../../../../../../app/src/Features/Authentication/AuthenticationManager.mjs', () => ({
  default: {
    hashPassword: vi.fn(),
  },
}))

vi.mock('../../../../../../app/src/Features/Security/OneTimeTokenHandler.mjs', () => ({
  default: {
    promises: {
      getNewToken: vi.fn(),
    },
  },
}))

vi.mock('../../../../../../app/src/models/User.mjs', () => ({
  User: {
    updateOne: vi.fn(),
  },
}))

describe('AdminUserBulkCreate Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('bulkCreateUsers creates users with passwords and activation links', async () => {
    UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
    UserCreator.promises.createNewUser.mockImplementation(details => ({
      _id: 'user-' + details.email,
      email: details.email,
      first_name: details.first_name,
      last_name: details.last_name,
    }))
    AuthenticationManager.hashPassword.mockResolvedValue('hashed-pass')
    OneTimeTokenHandler.promises.getNewToken.mockResolvedValue('token-abc')

    const req = {
      body: {
        users: [
          {
            email: 'alice@example.com',
            first_name: 'Alice',
            last_name: 'Smith',
            password: 'Password123!',
            isAdmin: false,
          },
          {
            email: 'bob@example.com',
            first_name: 'Bob',
            last_name: 'Jones',
            password: '',
            isAdmin: true,
          },
        ],
      },
      session: {},
      ip: '127.0.0.1',
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.bulkCreateUsers(req, res)

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        summary: { total: 2, createdCount: 2, skippedCount: 0, failedCount: 0 },
        created: expect.arrayContaining([
          expect.objectContaining({
            email: 'alice@example.com',
            passwordSet: true,
          }),
          expect.objectContaining({
            email: 'bob@example.com',
            passwordSet: false,
          }),
        ]),
      })
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBulkCreate.test.mjs`
Expected: FAIL with `bulkCreateUsers is not a function`.

- [ ] **Step 3: Implement controller and router methods**

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`:
```javascript
import UserCreator from '../../../../app/src/Features/User/UserCreator.mjs'
import AuthenticationManager from '../../../../app/src/Features/Authentication/AuthenticationManager.mjs'
import OneTimeTokenHandler from '../../../../app/src/Features/Security/OneTimeTokenHandler.mjs'
import Settings from '@overleaf/settings'

// Inside controller:
  async bulkCreateUsers(req, res) {
    try {
      const rawUsers = req.body?.users
      if (!Array.isArray(rawUsers) || rawUsers.length === 0) {
        return res.status(400).json({ error: 'invalid_users_array' })
      }

      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      const created = []
      const skipped = []
      const failed = []

      for (const row of rawUsers) {
        const parsedEmail = EmailHelper.parseEmail(row?.email)
        if (!parsedEmail) {
          failed.push({ email: row?.email || '', reason: 'invalid_email' })
          continue
        }

        const existing = await UserGetter.promises.getUserByAnyEmail(parsedEmail)
        if (existing) {
          skipped.push({ email: parsedEmail, reason: 'email_already_exists' })
          continue
        }

        const firstName = (row.first_name || '').trim()
        const lastName = (row.last_name || '').trim()
        const isAdmin = Boolean(row.isAdmin)
        const rawPassword = (row.password || '').trim()

        const newUser = await UserCreator.promises.createNewUser(
          {
            email: parsedEmail,
            first_name: firstName,
            last_name: lastName,
            isAdmin,
            holdingAccount: false,
          },
          {}
        )

        let passwordSet = false
        let setupUrl = null

        if (rawPassword.length > 0) {
          const hashedPassword = await AuthenticationManager.hashPassword(rawPassword)
          await User.updateOne(
            { _id: newUser._id },
            { $set: { hashedPassword, loginCount: 0 } }
          )
          passwordSet = true
        } else {
          const token = await OneTimeTokenHandler.promises.getNewToken(
            'password',
            newUser._id
          )
          const siteUrl = Settings.siteUrl || ''
          setupUrl = `${siteUrl}/user/password/set?token=${token}`
        }

        await UserAuditLogHandler.promises.addEntry(
          newUser._id.toString(),
          'admin-register',
          callerUserId,
          req.ip,
          { isAdmin, passwordSet }
        )

        created.push({
          _id: newUser._id.toString(),
          email: parsedEmail,
          first_name: firstName,
          last_name: lastName,
          isAdmin,
          passwordSet,
          setupUrl,
        })
      }

      return res.json({
        success: true,
        summary: {
          total: rawUsers.length,
          createdCount: created.length,
          skippedCount: skipped.length,
          failedCount: failed.length,
        },
        created,
        skipped,
        failed,
      })
    } catch (err) {
      logger.error({ err }, 'error bulk creating users')
      return res.status(500).json({ error: 'failed_to_bulk_create_users' })
    }
  },
```

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`:
```javascript
    webRouter.post(
      '/admin/users/api/users/bulk-create',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.bulkCreateUsers
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserBulkCreate.test.mjs`
Expected: PASS.

---

### Task 3: Security Audit Trail Card Component

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-audit-trail-card.tsx`
- Modify: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-detail-page.tsx`

- [ ] **Step 1: Create `admin-user-audit-trail-card.tsx`**

Implement `AdminUserAuditTrailCard`:
- Fetches `getJSON('/admin/users/api/users/' + userId + '/audit-logs?page=' + page)`.
- Renders timeline with badges (`[Site Admin]`, `[Sessions]`, `[Email]`, `[Password]`, `[Account]`, `[Projects]`).
- Includes a "Load More Events" button.

- [ ] **Step 2: Mount inside `admin-user-detail-page.tsx`**

Place `<AdminUserAuditTrailCard>` below the Projects card.

---

### Task 4: Single & Bulk User Creation Modal Component

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/create-users-modal.tsx`
- Modify: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-list-page.tsx`

- [ ] **Step 1: Create `create-users-modal.tsx`**

Implement `CreateUsersModal`:
- Tab 1: Single User Form (`Email`, `First Name`, `Last Name`, `Password`, `Admin?`).
- Tab 2: Bulk / CSV Import (multi-row editable table + CSV file drag & drop parser).
- Summary Screen on submit with copyable links and "Export Results as CSV".

- [ ] **Step 2: Connect to `admin-user-list-page.tsx`**

Change the "Add new users" button in `admin-user-list-page.tsx` from `href="/admin/register"` to `onClick={() => setShowCreateModal(true)}`.

- [ ] **Step 3: Verify Webpack compilation**

Run: `docker compose logs --tail=10 webpack`
Expected: `webpack 5.106.2 compiled successfully`.

---

### Task 5: Live Container E2E Integration & Verification

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/`
Expected: All unit tests pass across all test files.

- [ ] **Step 2: Run container E2E integration test**

Execute live tests in container:
- Bulk create users with explicit password and without password.
- Query user audit trail.
Expected: PASS (0 errors).
