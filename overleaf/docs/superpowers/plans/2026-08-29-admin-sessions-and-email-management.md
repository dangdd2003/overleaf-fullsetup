# Phase 1: Real-Time Active Sessions & Admin Email Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement real-time Redis active sessions inspection, force-logout (session revocation), and administrative MongoDB email management (add confirmed secondary email, remove secondary email, promote secondary email to primary) inside the Overleaf Admin User Management module.

**Architecture:** Extend `AdminUserManagementRouter.mjs` and `AdminUserManagementController.mjs` with 5 rate-limited, site-admin-guarded REST endpoints integrating directly with Redis `UserSessionsManager` and MongoDB `UserUpdater`/`UserGetter`. On the frontend, enhance `/admin/users/:userId` with an interactive Email Addresses table inside the Profile card, and add a dedicated Security & Active Sessions card with a confirmation modal.

**Tech Stack:** Node.js (ESM), Express 4, Redis (ioredis), MongoDB (mongodb native driver / Mongoose), React 18, TypeScript, Vitest, Bootstrap 5 / Overleaf Design Tokens (`OLCard`, `OLButton`, `OLBadge`, `OLModal`).

## Global Constraints

- **Directory Boundary**: All new backend logic and frontend components MUST be placed inside `overleaf/services/web/modules/admin-user-management/`.
- **Authorization**: Every new endpoint MUST require `AuthorizationMiddleware.ensureUserIsSiteAdmin` and mutation endpoints MUST be wrapped with `RateLimiterMiddleware.rateLimit(rateLimiter)`.
- **Zero Raw Password Exposure**: No plaintext passwords handled; secondary emails are added directly as verified for admin convenience.
- **Self-Revocation Invariant**: When an admin revokes their own sessions, `retainSessionID: req.sessionID` MUST be passed to `UserSessionsManager.removeSessionsFromRedis` to prevent admin self-lockout.
- **Primary Email Protection**: An admin CANNOT remove a user's primary email (`cannot_remove_primary_email`).
- **Git Rules**: Never run `git commit` or `git push` directly in automation; provide clean commands for the user.

---

### Task 1: Active Sessions Query & Revoke Endpoints

**Files:**
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserSessions.test.mjs`

**Interfaces:**
- `AdminUserManagementController.getUserSessions(req, res)`:
  - Params: `req.params.userId`
  - Output: `200 { sessions: [{ ip_address, session_created }], count: number }`
- `AdminUserManagementController.revokeUserSessions(req, res)`:
  - Params: `req.params.userId`
  - Output: `200 { success: true, revokedCount: number }`

- [ ] **Step 1: Write the failing unit test for sessions controller**

Create `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserSessions.test.mjs`:
```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminUserManagementController from '../../../../app/src/AdminUserManagementController.mjs'
import UserSessionsManager from '../../../../../../app/src/Features/User/UserSessionsManager.mjs'
import SessionManager from '../../../../../../app/src/Features/Authentication/SessionManager.mjs'

vi.mock('../../../../../../app/src/Features/User/UserSessionsManager.mjs', () => ({
  default: {
    getAllUserSessions: vi.fn(),
    removeSessionsFromRedis: vi.fn(),
  },
}))

vi.mock('../../../../../../app/src/Features/Authentication/SessionManager.mjs', () => ({
  default: {
    getLoggedInUserId: vi.fn(),
  },
}))

describe('AdminUserSessions Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getUserSessions returns sessions array and count from Redis', async () => {
    UserSessionsManager.getAllUserSessions.mockResolvedValue([
      { ip_address: '192.168.1.1', session_created: '2026-08-29T10:00:00.000Z' },
    ])

    const req = { params: { userId: '6a929d69c5fd734cf2a08f76' } }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.getUserSessions(req, res)

    expect(UserSessionsManager.getAllUserSessions).toHaveBeenCalledWith({
      _id: '6a929d69c5fd734cf2a08f76',
    })
    expect(res.json).toHaveBeenCalledWith({
      sessions: [
        { ip_address: '192.168.1.1', session_created: '2026-08-29T10:00:00.000Z' },
      ],
      count: 1,
    })
  })

  it('revokeUserSessions purges sessions and passes retainSessionID when revoking self', async () => {
    SessionManager.getLoggedInUserId.mockReturnValue('6a929d69c5fd734cf2a08f76')
    UserSessionsManager.removeSessionsFromRedis.mockResolvedValue(2)

    const req = {
      params: { userId: '6a929d69c5fd734cf2a08f76' },
      session: {},
      sessionID: 'sess-12345',
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.revokeUserSessions(req, res)

    expect(UserSessionsManager.removeSessionsFromRedis).toHaveBeenCalledWith(
      { _id: '6a929d69c5fd734cf2a08f76' },
      'sess-12345'
    )
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      revokedCount: 2,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserSessions.test.mjs`
Expected: FAIL with `AdminUserManagementController.getUserSessions is not a function`.

- [ ] **Step 3: Implement controller and router methods**

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`, add imports and methods:
```javascript
import UserSessionsManager from '../../../../app/src/Features/User/UserSessionsManager.mjs'

// Inside AdminUserManagementController:
  async getUserSessions(req, res) {
    try {
      const { userId } = req.params
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const sessions = await UserSessionsManager.getAllUserSessions({ _id: userId })
      return res.json({
        sessions: sessions || [],
        count: (sessions || []).length,
      })
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'error getting user sessions')
      return res.status(500).json({ error: 'failed_to_get_sessions' })
    }
  },

  async revokeUserSessions(req, res) {
    try {
      const { userId } = req.params
      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const retainSessionID = callerUserId === userId ? req.sessionID : null
      const revokedCount = await UserSessionsManager.removeSessionsFromRedis(
        { _id: userId },
        retainSessionID
      )

      return res.json({
        success: true,
        revokedCount: typeof revokedCount === 'number' ? revokedCount : 0,
      })
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'error revoking user sessions')
      return res.status(500).json({ error: 'failed_to_revoke_sessions' })
    }
  },
```

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`, register routes:
```javascript
    webRouter.get(
      '/admin/users/api/users/:userId/sessions',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.getUserSessions
    )

    webRouter.post(
      '/admin/users/api/users/:userId/sessions/revoke',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.revokeUserSessions
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserSessions.test.mjs`
Expected: PASS (2 tests passed).

---

### Task 2: Admin Email Management Endpoints (Add, Remove, Set-Primary)

**Files:**
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserEmails.test.mjs`

**Interfaces:**
- `AdminUserManagementController.addEmail(req, res)`:
  - Body: `{ email: string }`
  - Output: `200 { success: true, user: UserDetail }` | `409 { error: 'email_already_registered' }`
- `AdminUserManagementController.removeEmail(req, res)`:
  - Body: `{ email: string }`
  - Output: `200 { success: true, user: UserDetail }` | `400 { error: 'cannot_remove_primary_email' }`
- `AdminUserManagementController.setPrimaryEmail(req, res)`:
  - Body: `{ email: string }`
  - Output: `200 { success: true, user: UserDetail }`

- [ ] **Step 1: Write failing unit test for email management controller**

Create `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserEmails.test.mjs`:
```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AdminUserManagementController from '../../../../app/src/AdminUserManagementController.mjs'
import UserGetter from '../../../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../../../app/src/Features/User/UserUpdater.mjs'
import AdminUserQuery from '../../../../app/src/AdminUserQuery.mjs'

vi.mock('../../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: {
    promises: {
      getUserByAnyEmail: vi.fn(),
      getUser: vi.fn(),
    },
  },
}))

vi.mock('../../../../../../app/src/Features/User/UserUpdater.mjs', () => ({
  default: {
    promises: {
      addEmailAddress: vi.fn(),
      removeEmailAddress: vi.fn(),
      setDefaultEmailAddress: vi.fn(),
    },
  },
}))

vi.mock('../../../../app/src/AdminUserQuery.mjs', () => ({
  default: {
    getUserById: vi.fn(),
  },
}))

describe('AdminUserEmails Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('addEmail rejects existing email with 409 conflict', async () => {
    UserGetter.promises.getUserByAnyEmail.mockResolvedValue({ _id: 'other-user' })

    const req = {
      params: { userId: '6a929d69c5fd734cf2a08f76' },
      body: { email: 'duplicate@example.com' },
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.addEmail(req, res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'email_already_registered' })
  })

  it('addEmail successfully adds secondary email and returns updated user', async () => {
    UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
    UserUpdater.promises.addEmailAddress.mockResolvedValue()
    AdminUserQuery.getUserById.mockResolvedValue({
      _id: '6a929d69c5fd734cf2a08f76',
      email: 'primary@example.com',
      emails: [
        { email: 'primary@example.com', default: true },
        { email: 'secondary@example.com', confirmedAt: new Date() },
      ],
    })

    const req = {
      params: { userId: '6a929d69c5fd734cf2a08f76' },
      body: { email: 'secondary@example.com' },
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.addEmail(req, res)

    expect(UserUpdater.promises.addEmailAddress).toHaveBeenCalledWith(
      '6a929d69c5fd734cf2a08f76',
      'secondary@example.com',
      { confirmed: true }
    )
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
      })
    )
  })

  it('removeEmail blocks deleting primary email with 400', async () => {
    UserGetter.promises.getUser.mockResolvedValue({
      _id: '6a929d69c5fd734cf2a08f76',
      email: 'primary@example.com',
    })

    const req = {
      params: { userId: '6a929d69c5fd734cf2a08f76' },
      body: { email: 'primary@example.com' },
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.removeEmail(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'cannot_remove_primary_email' })
  })

  it('setPrimaryEmail invokes setDefaultEmailAddress and returns updated user', async () => {
    UserUpdater.promises.setDefaultEmailAddress.mockResolvedValue()
    AdminUserQuery.getUserById.mockResolvedValue({
      _id: '6a929d69c5fd734cf2a08f76',
      email: 'secondary@example.com',
    })

    const req = {
      params: { userId: '6a929d69c5fd734cf2a08f76' },
      body: { email: 'secondary@example.com' },
    }
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }

    await AdminUserManagementController.setPrimaryEmail(req, res)

    expect(UserUpdater.promises.setDefaultEmailAddress).toHaveBeenCalledWith(
      '6a929d69c5fd734cf2a08f76',
      'secondary@example.com'
    )
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
      })
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserEmails.test.mjs`
Expected: FAIL with `AdminUserManagementController.addEmail is not a function`.

- [ ] **Step 3: Implement email management methods in controller and router**

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementController.mjs`:
```javascript
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../app/src/Features/User/UserUpdater.mjs'
import EmailHelper from '../../../../app/src/Features/Helpers/EmailHelper.mjs'

// Inside AdminUserManagementController:
  async addEmail(req, res) {
    try {
      const { userId } = req.params
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const email = EmailHelper.parseEmail(req.body?.email)
      if (!email) {
        return res.status(400).json({ error: 'invalid_email' })
      }

      const existingUser = await UserGetter.promises.getUserByAnyEmail(email)
      if (existingUser) {
        return res.status(409).json({ error: 'email_already_registered' })
      }

      await UserUpdater.promises.addEmailAddress(userId, email, { confirmed: true })
      const updatedUser = await AdminUserQuery.getUserById(userId)

      return res.json({
        success: true,
        user: updatedUser,
      })
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'error adding email to user')
      return res.status(500).json({ error: 'failed_to_add_email' })
    }
  },

  async removeEmail(req, res) {
    try {
      const { userId } = req.params
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const email = EmailHelper.parseEmail(req.body?.email)
      if (!email) {
        return res.status(400).json({ error: 'invalid_email' })
      }

      const user = await UserGetter.promises.getUser(userId, { email: 1 })
      if (!user) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      if (user.email.toLowerCase() === email.toLowerCase()) {
        return res.status(400).json({ error: 'cannot_remove_primary_email' })
      }

      await UserUpdater.promises.removeEmailAddress(userId, email)
      const updatedUser = await AdminUserQuery.getUserById(userId)

      return res.json({
        success: true,
        user: updatedUser,
      })
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'error removing email from user')
      return res.status(500).json({ error: 'failed_to_remove_email' })
    }
  },

  async setPrimaryEmail(req, res) {
    try {
      const { userId } = req.params
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const email = EmailHelper.parseEmail(req.body?.email)
      if (!email) {
        return res.status(400).json({ error: 'invalid_email' })
      }

      await UserUpdater.promises.setDefaultEmailAddress(userId, email)
      const updatedUser = await AdminUserQuery.getUserById(userId)

      return res.json({
        success: true,
        user: updatedUser,
      })
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'error setting primary email')
      return res.status(500).json({ error: 'failed_to_set_primary_email' })
    }
  },
```

In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`:
```javascript
    webRouter.post(
      '/admin/users/api/users/:userId/emails/add',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.addEmail
    )

    webRouter.post(
      '/admin/users/api/users/:userId/emails/remove',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.removeEmail
    )

    webRouter.post(
      '/admin/users/api/users/:userId/emails/set-primary',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminUserManagementController.setPrimaryEmail
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserEmails.test.mjs`
Expected: PASS (4 tests passed).

---

### Task 3: Interactive Email Management Sub-Component

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-emails-card.tsx`
- Modify: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-detail-page.tsx`

**Interfaces:**
- Props for `AdminUserEmailsCard`:
  ```typescript
  interface AdminUserEmailsCardProps {
    userId: string
    primaryEmail: string
    emails?: Array<{ email: string; confirmedAt?: string | Date }>
    onUserUpdated: (updatedUser: UserDetail) => void
    onError: (err: string) => void
    onSuccess: (msg: string) => void
  }
  ```

- [ ] **Step 1: Create `AdminUserEmailsCard` component**

Create `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-emails-card.tsx`:
- Render primary email with `<OLBadge bg="primary">Primary</OLBadge>`.
- Render secondary emails with "Make Primary" button and "Remove" button.
- Render "Add Secondary Email" inline form with text input and submit button.
- Wrap API calls (`/admin/users/api/users/${userId}/emails/*`) with `postJSON(url, { body: { email } })`.

- [ ] **Step 2: Integrate `AdminUserEmailsCard` into `admin-user-detail-page.tsx`**

Replace static email list inside the Profile card of `admin-user-detail-page.tsx` with `<AdminUserEmailsCard>`.

- [ ] **Step 3: Verify Webpack compiles cleanly**

Run: `docker compose logs --tail=10 webpack`
Expected: `webpack 5.106.2 compiled successfully`.

---

### Task 4: Security & Active Sessions Card & Revocation Modal

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/revoke-sessions-modal.tsx`
- Create: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-sessions-card.tsx`
- Modify: `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-detail-page.tsx`

**Interfaces:**
- `AdminUserSessionsCardProps`:
  ```typescript
  interface AdminUserSessionsCardProps {
    userId: string
    userEmail: string
    onError: (err: string) => void
    onSuccess: (msg: string) => void
  }
  ```

- [ ] **Step 1: Create `RevokeSessionsModal`**

Create `overleaf/services/web/modules/admin-user-management/frontend/js/components/revoke-sessions-modal.tsx`:
- Use `OLModal`, `OLModalHeader`, `OLModalBody`, `OLModalFooter`.
- State `isLoading`, `error`.
- On confirm, dispatch `postJSON('/admin/users/api/users/${userId}/sessions/revoke', { body: {} })`.

- [ ] **Step 2: Create `AdminUserSessionsCard`**

Create `overleaf/services/web/modules/admin-user-management/frontend/js/components/admin-user-sessions-card.tsx`:
- `useEffect` hook to fetch `getJSON('/admin/users/api/users/${userId}/sessions')`.
- Displays active session counter badge (`<OLBadge bg="info">{count} Active Sessions</OLBadge>`).
- Renders list of IP addresses and relative login dates.
- Renders "Revoke All Sessions (Force Logout)" button opening `RevokeSessionsModal`.

- [ ] **Step 3: Mount `AdminUserSessionsCard` in Right Column of `admin-user-detail-page.tsx`**

Place right beneath the Password Management card.

- [ ] **Step 4: Verify Webpack compilation**

Run: `docker compose logs --tail=10 webpack`
Expected: `webpack 5.106.2 compiled successfully`.

---

### Task 5: End-to-End Container Verification & Full Unit Suite

**Files:**
- Run: Vitest suite across all unit tests
- Run: Scratch container E2E test script

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run overleaf/services/web/modules/admin-user-management/test/unit/`
Expected: PASS (All 30 unit tests pass across 6 test files).

- [ ] **Step 2: Run container E2E integration test**

Execute live tests in `web` container against Redis and MongoDB:
- Verify session creation and revocation.
- Verify adding, setting primary, and removing secondary emails.
Expected: PASS (All live tests succeed with 0 errors).
