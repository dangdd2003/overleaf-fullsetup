# Self-Service Secondary Emails for Overleaf Community Edition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement native, self-service secondary email management for Overleaf Community Edition within the `admin-user-management` module, allowing users to add auto-confirmed secondary emails, promote them to primary, and delete secondary emails without affiliations or institutional SSO.

**Architecture:** A dedicated backend controller (`AdminUserSelfServiceEmailsController.mjs`) mounted via `AdminUserManagementRouter.mjs` handles `POST /user/emails/secondary`, `POST /user/emails/default`, and `POST /user/emails/delete` guarded by session authentication and rate limiting. The frontend in `overleaf/services/web/frontend/js/features/settings` renders simplified, affiliation-free components (`SimpleEmailsHeader`, `SimpleEmailsRow`, `SimpleAddEmailForm`) within `emails-section.tsx` when `admin-user-management` is enabled and `affiliations` is disabled.

**Tech Stack:** Node.js (ESM), Express, MongoDB/Mongoose, React 18, TypeScript, Vitest, Mocha/Chai, React Testing Library, Playwright.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-10-admin-user-management-secondary-emails-design.md`

## Global Constraints
- Target platform: Overleaf Community Edition (Server CE).
- Parent module: `admin-user-management` (`overleaf/services/web/modules/admin-user-management/`).
- Feature flag: `Features.hasFeature('admin-user-management')` (`enableAdminUserManagement` setting or `ADMIN_USER_MANAGEMENT_ENABLED=true` env var).
- Auto-confirmation: In CE setups, newly added secondary emails are auto-confirmed immediately (`confirmedAt: new Date()`) without confirmation email codes.
- Primary email safety invariant: The primary email cannot be removed. Users must promote another confirmed email to primary before deleting an old primary address.
- Email uniqueness: Newly added emails must be verified against collisions in both active and deleted users via `UserGetter.getUserByAnyEmail`.
- Email limits: Enforce `Settings.emailAddressLimit` (default: 10 emails per account).
- Audit trail: All operations must record audit entries (`add-email-auto-confirmed`, `set-default-email`, `remove-email`) via `UserAuditLogHandler`.
- Test execution in worktree sandbox: Symlink `overleaf/node_modules` from `/home/dangdd/projects/overleaf-fullsetup/overleaf/node_modules` into `overleaf/node_modules` if needed.

---

### Task 1: Backend Self-Service Emails Controller (`AdminUserSelfServiceEmailsController.mjs`)

**Files:**
- Create: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserSelfServiceEmailsController.mjs`
- Test: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserSelfServiceEmails.test.mjs`

**Interfaces:**
- Produces:
  - `AdminUserSelfServiceEmailsController.addSecondaryEmail(req, res): Promise<void>` (handles `POST /user/emails/secondary`)
  - `AdminUserSelfServiceEmailsController.setDefaultEmail(req, res): Promise<void>` (handles `POST /user/emails/default`)
  - `AdminUserSelfServiceEmailsController.deleteSecondaryEmail(req, res): Promise<void>` (handles `POST /user/emails/delete`)
- Consumes:
  - `SessionManager.getLoggedInUserId(req.session)`
  - `EmailHelper.parseEmail(email)`
  - `UserGetter.getUser(userId, projection)`
  - `UserGetter.getUserByAnyEmail(email)`
  - `UserUpdater.addEmailAddress(userId, email, options, auditLog)`
  - `UserUpdater.confirmEmail(userId, email)`
  - `UserUpdater.setDefaultEmailAddress(userId, email, confirmed, auditLog, notify, deleteOldEmail)`
  - `UserUpdater.removeEmailAddress(userId, email, auditLog)`
  - `UserSessionsManager.removeSessionsFromRedis(user, currentSessionId)`
  - `UserAuditLogHandler.addEntry(userId, action, initiatorId, ip, details)`

- [ ] **Step 1: Write the failing unit tests for AdminUserSelfServiceEmailsController**

Create `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserSelfServiceEmails.test.mjs`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserGetter from '../../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../../app/src/Features/User/UserUpdater.mjs'
import EmailHelper from '../../../../../app/src/Features/Helpers/EmailHelper.mjs'
import UserAuditLogHandler from '../../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import UserSessionsManager from '../../../../../app/src/Features/User/UserSessionsManager.mjs'
import AdminUserSelfServiceEmailsController from '../../../app/src/AdminUserSelfServiceEmailsController.mjs'

vi.mock('@overleaf/settings', () => ({
  default: {
    siteUrl: 'https://overleaf.example.com',
    emailAddressLimit: 10,
  },
}))

vi.mock('@overleaf/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/infrastructure/mongodb.mjs', () => {
  class MockObjectId {
    constructor(id) {
      this.id = id || '507f1f77bcf86cd799439011'
    }
    toString() {
      return this.id
    }
    static isValid(id) {
      return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)
    }
  }

  return {
    ObjectId: MockObjectId,
  }
})

vi.mock('../../../../../app/src/Features/Authentication/SessionManager.mjs', () => ({
  default: {
    getLoggedInUserId: vi.fn(),
    setInSessionUser: vi.fn(),
    getSessionUser: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: {
    promises: {
      getUser: vi.fn(),
      getUserByAnyEmail: vi.fn(),
    },
    getUser: vi.fn(),
    getUserByAnyEmail: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserUpdater.mjs', () => ({
  default: {
    promises: {
      addEmailAddress: vi.fn(),
      confirmEmail: vi.fn(),
      removeEmailAddress: vi.fn(),
      setDefaultEmailAddress: vi.fn(),
    },
    addEmailAddress: vi.fn(),
    confirmEmail: vi.fn(),
    removeEmailAddress: vi.fn(),
    setDefaultEmailAddress: vi.fn(),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserSessionsManager.mjs', () => ({
  default: {
    promises: {
      removeSessionsFromRedis: vi.fn(),
    },
  },
}))

vi.mock('../../../../../app/src/Features/Helpers/EmailHelper.mjs', () => ({
  default: {
    parseEmail: vi.fn(email => {
      if (
        typeof email !== 'string' ||
        !email.includes('@') ||
        email.includes(' ') ||
        email.startsWith('@') ||
        email.endsWith('@')
      ) {
        return null
      }
      return email.trim().toLowerCase()
    }),
  },
}))

vi.mock('../../../../../app/src/Features/User/UserAuditLogHandler.mjs', () => ({
  default: {
    promises: {
      addEntry: vi.fn(),
    },
  },
}))

function createMockReqRes({ sessionUserId = '507f1f77bcf86cd799439011', body = {}, query = {} } = {}) {
  const req = {
    session: {
      user: { _id: sessionUserId, email: 'primary@example.com' },
    },
    sessionID: 'mock-session-id',
    ip: '127.0.0.1',
    body,
    query,
  }

  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(data) {
      this.body = data
      return this
    },
    sendStatus(code) {
      this.statusCode = code
      return this
    },
  }

  SessionManager.getLoggedInUserId.mockReturnValue(sessionUserId)
  SessionManager.getSessionUser.mockReturnValue({ _id: sessionUserId, email: 'primary@example.com' })

  return { req, res }
}

describe('AdminUserSelfServiceEmailsController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('addSecondaryEmail', () => {
    it('returns 400 if email is missing or invalid', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'invalid-email' } })

      await AdminUserSelfServiceEmailsController.addSecondaryEmail(req, res)

      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_email' })
    })

    it('returns 404 if user is not found', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'secondary@example.com' } })
      UserGetter.promises.getUser.mockResolvedValue(null)

      await AdminUserSelfServiceEmailsController.addSecondaryEmail(req, res)

      expect(res.statusCode).toBe(404)
      expect(res.body).toEqual({ error: 'user_not_found' })
    })

    it('returns 422 if user exceeds emailAddressLimit', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'secondary@example.com' } })
      const tenEmails = Array.from({ length: 10 }, (_, i) => ({ email: `email${i}@example.com` }))
      UserGetter.promises.getUser.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'primary@example.com',
        emails: tenEmails,
      })

      await AdminUserSelfServiceEmailsController.addSecondaryEmail(req, res)

      expect(res.statusCode).toBe(422)
      expect(res.body).toEqual({ error: 'email_limit_exceeded' })
    })

    it('returns 409 if email already exists in system', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'existing@example.com' } })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'primary@example.com',
        emails: [{ email: 'primary@example.com' }],
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue({
        _id: 'other-user-id',
        email: 'existing@example.com',
      })

      await AdminUserSelfServiceEmailsController.addSecondaryEmail(req, res)

      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual({ error: 'email_already_registered' })
    })

    it('adds and auto-confirms secondary email and returns 200', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'secondary@example.com' } })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'primary@example.com',
        emails: [{ email: 'primary@example.com' }],
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserUpdater.promises.addEmailAddress.mockResolvedValue()
      UserUpdater.promises.confirmEmail.mockResolvedValue()
      UserAuditLogHandler.promises.addEntry.mockResolvedValue()

      await AdminUserSelfServiceEmailsController.addSecondaryEmail(req, res)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ success: true, email: 'secondary@example.com' })
      expect(UserUpdater.promises.addEmailAddress).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439011',
        'secondary@example.com',
        { confirmed: true },
        expect.objectContaining({ initiatorId: '507f1f77bcf86cd799439011' })
      )
      expect(UserUpdater.promises.confirmEmail).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439011',
        'secondary@example.com'
      )
      expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
        expect.anything(),
        'add-email-auto-confirmed',
        '507f1f77bcf86cd799439011',
        '127.0.0.1',
        { email: 'secondary@example.com' }
      )
    })
  })

  describe('setDefaultEmail', () => {
    it('returns 400 if email is invalid', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'not-an-email' } })

      await AdminUserSelfServiceEmailsController.setDefaultEmail(req, res)

      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_email' })
    })

    it('returns 404 if email does not belong to user', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'unknown@example.com' } })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'primary@example.com',
        emails: [{ email: 'primary@example.com', confirmedAt: new Date() }],
      })

      await AdminUserSelfServiceEmailsController.setDefaultEmail(req, res)

      expect(res.statusCode).toBe(404)
      expect(res.body).toEqual({ error: 'email_not_found' })
    })

    it('returns 400 if email is not confirmed', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'unconfirmed@example.com' } })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'primary@example.com',
        emails: [
          { email: 'primary@example.com', confirmedAt: new Date() },
          { email: 'unconfirmed@example.com', confirmedAt: null },
        ],
      })

      await AdminUserSelfServiceEmailsController.setDefaultEmail(req, res)

      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'email_not_confirmed' })
    })

    it('sets default email, updates session, revokes other sessions and returns 200', async () => {
      const { req, res } = createMockReqRes({
        body: { email: 'secondary@example.com' },
        query: { 'delete-unconfirmed-primary': '' },
      })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'primary@example.com',
        emails: [
          { email: 'primary@example.com', confirmedAt: new Date() },
          { email: 'secondary@example.com', confirmedAt: new Date() },
        ],
      })
      UserUpdater.promises.setDefaultEmailAddress.mockResolvedValue()
      UserSessionsManager.promises.removeSessionsFromRedis.mockResolvedValue()
      UserAuditLogHandler.promises.addEntry.mockResolvedValue()

      await AdminUserSelfServiceEmailsController.setDefaultEmail(req, res)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ success: true })
      expect(UserUpdater.promises.setDefaultEmailAddress).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439011',
        'secondary@example.com',
        false,
        expect.objectContaining({ initiatorId: '507f1f77bcf86cd799439011' }),
        true,
        false
      )
      expect(SessionManager.setInSessionUser).toHaveBeenCalledWith(req.session, {
        email: 'secondary@example.com',
      })
      expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
        expect.anything(),
        'set-default-email',
        '507f1f77bcf86cd799439011',
        '127.0.0.1',
        { email: 'secondary@example.com' }
      )
    })
  })

  describe('deleteSecondaryEmail', () => {
    it('returns 400 if email is invalid', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'invalid' } })

      await AdminUserSelfServiceEmailsController.deleteSecondaryEmail(req, res)

      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'invalid_email' })
    })

    it('returns 400 when attempting to delete the primary email', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'primary@example.com' } })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'primary@example.com',
        emails: [
          { email: 'primary@example.com', confirmedAt: new Date() },
          { email: 'secondary@example.com', confirmedAt: new Date() },
        ],
      })

      await AdminUserSelfServiceEmailsController.deleteSecondaryEmail(req, res)

      expect(res.statusCode).toBe(400)
      expect(res.body).toEqual({ error: 'cannot_delete_primary_email' })
    })

    it('returns 404 if email is not found in user emails', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'missing@example.com' } })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'primary@example.com',
        emails: [{ email: 'primary@example.com', confirmedAt: new Date() }],
      })

      await AdminUserSelfServiceEmailsController.deleteSecondaryEmail(req, res)

      expect(res.statusCode).toBe(404)
      expect(res.body).toEqual({ error: 'email_not_found' })
    })

    it('deletes secondary email and returns 200', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'secondary@example.com' } })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'primary@example.com',
        emails: [
          { email: 'primary@example.com', confirmedAt: new Date() },
          { email: 'secondary@example.com', confirmedAt: new Date() },
        ],
      })
      UserUpdater.promises.removeEmailAddress.mockResolvedValue()
      UserAuditLogHandler.promises.addEntry.mockResolvedValue()

      await AdminUserSelfServiceEmailsController.deleteSecondaryEmail(req, res)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ success: true })
      expect(UserUpdater.promises.removeEmailAddress).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439011',
        'secondary@example.com',
        expect.objectContaining({ initiatorId: '507f1f77bcf86cd799439011' })
      )
      expect(UserAuditLogHandler.promises.addEntry).toHaveBeenCalledWith(
        expect.anything(),
        'remove-email',
        '507f1f77bcf86cd799439011',
        '127.0.0.1',
        { email: 'secondary@example.com' }
      )
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && npx vitest run modules/admin-user-management/test/unit/src/AdminUserSelfServiceEmails.test.mjs
```
Expected: FAIL with "Cannot find module ... AdminUserSelfServiceEmailsController.mjs"

- [ ] **Step 3: Implement AdminUserSelfServiceEmailsController.mjs**

Create `overleaf/services/web/modules/admin-user-management/app/src/AdminUserSelfServiceEmailsController.mjs`:

```javascript
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../app/src/Features/User/UserUpdater.mjs'
import UserSessionsManager from '../../../../app/src/Features/User/UserSessionsManager.mjs'
import EmailHelper from '../../../../app/src/Features/Helpers/EmailHelper.mjs'
import UserAuditLogHandler from '../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'

const AdminUserSelfServiceEmailsController = {
  async addSecondaryEmail(req, res) {
    try {
      const userId = SessionManager.getLoggedInUserId(req.session)
      if (!userId) {
        return res.status(401).json({ error: 'unauthorized' })
      }

      const { email } = req.body || {}
      const parsedEmail = EmailHelper.parseEmail(email)
      if (!parsedEmail) {
        return res.status(400).json({ error: 'invalid_email' })
      }

      const userGetter = UserGetter.promises || UserGetter
      const user = await userGetter.getUser(userId, { emails: 1, email: 1 })
      if (!user) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      const emailLimit = Settings.emailAddressLimit || 10
      if (user.emails && user.emails.length >= emailLimit) {
        return res.status(422).json({ error: 'email_limit_exceeded' })
      }

      const existingUser = await (
        userGetter.getUserByAnyEmail || UserGetter.getUserByAnyEmail
      )(parsedEmail)
      if (existingUser) {
        return res.status(409).json({ error: 'email_already_registered' })
      }

      const userUpdater = UserUpdater.promises || UserUpdater
      const auditLog = {
        initiatorId: userId,
        ipAddress: req.ip || '0.0.0.0',
        info: {},
      }

      await userUpdater.addEmailAddress(
        userId,
        parsedEmail,
        { confirmed: true },
        auditLog
      )

      const confirmFn =
        userUpdater.confirmEmail || UserUpdater.promises?.confirmEmail
      if (confirmFn) {
        await confirmFn(userId, parsedEmail)
      }

      const auditLogHandler =
        UserAuditLogHandler.promises || UserAuditLogHandler
      await auditLogHandler.addEntry(
        new ObjectId(userId),
        'add-email-auto-confirmed',
        userId,
        req.ip || '0.0.0.0',
        { email: parsedEmail }
      )

      return res.status(200).json({
        success: true,
        email: parsedEmail,
      })
    } catch (err) {
      if (
        err.name === 'EmailExistsError' ||
        err.message?.includes('already registered') ||
        err.message?.includes('already exists')
      ) {
        return res.status(409).json({ error: 'email_already_registered' })
      }
      logger.error(
        { err, sessionUserId: SessionManager.getLoggedInUserId(req.session), body: req.body },
        'Failed to add self-service secondary email'
      )
      return res.status(500).json({ error: 'failed_to_add_email' })
    }
  },

  async setDefaultEmail(req, res) {
    try {
      const userId = SessionManager.getLoggedInUserId(req.session)
      if (!userId) {
        return res.status(401).json({ error: 'unauthorized' })
      }

      const { email } = req.body || {}
      const parsedEmail = EmailHelper.parseEmail(email)
      if (!parsedEmail) {
        return res.status(400).json({ error: 'invalid_email' })
      }

      const userGetter = UserGetter.promises || UserGetter
      const user = await userGetter.getUser(userId, { emails: 1, email: 1 })
      if (!user) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      const targetEmailData = user.emails?.find(e => e.email === parsedEmail)
      if (!targetEmailData) {
        return res.status(404).json({ error: 'email_not_found' })
      }

      if (!targetEmailData.confirmedAt) {
        return res.status(400).json({ error: 'email_not_confirmed' })
      }

      const primaryEmailData = user.emails?.find(e => e.email === user.email)
      const deleteOldEmail =
        req.query['delete-unconfirmed-primary'] !== undefined &&
        primaryEmailData &&
        !primaryEmailData.confirmedAt

      const auditLog = {
        initiatorId: userId,
        ipAddress: req.ip || '0.0.0.0',
        info: {},
      }

      const userUpdater = UserUpdater.promises || UserUpdater
      await userUpdater.setDefaultEmailAddress(
        userId,
        parsedEmail,
        false,
        auditLog,
        true,
        deleteOldEmail
      )

      SessionManager.setInSessionUser(req.session, { email: parsedEmail })
      const sessionUser = SessionManager.getSessionUser(req.session)
      try {
        const sessionManager =
          UserSessionsManager.promises || UserSessionsManager
        await sessionManager.removeSessionsFromRedis(sessionUser, req.sessionID)
      } catch (sessionErr) {
        logger.warn(
          { err: sessionErr },
          'Failed revoking secondary sessions after setting default email'
        )
      }

      const auditLogHandler =
        UserAuditLogHandler.promises || UserAuditLogHandler
      await auditLogHandler.addEntry(
        new ObjectId(userId),
        'set-default-email',
        userId,
        req.ip || '0.0.0.0',
        { email: parsedEmail }
      )

      return res.status(200).json({ success: true })
    } catch (err) {
      logger.error(
        { err, sessionUserId: SessionManager.getLoggedInUserId(req.session), body: req.body },
        'Failed to set default email'
      )
      return res.status(500).json({ error: 'failed_to_set_default_email' })
    }
  },

  async deleteSecondaryEmail(req, res) {
    try {
      const userId = SessionManager.getLoggedInUserId(req.session)
      if (!userId) {
        return res.status(401).json({ error: 'unauthorized' })
      }

      const { email } = req.body || {}
      const parsedEmail = EmailHelper.parseEmail(email)
      if (!parsedEmail) {
        return res.status(400).json({ error: 'invalid_email' })
      }

      const userGetter = UserGetter.promises || UserGetter
      const user = await userGetter.getUser(userId, { emails: 1, email: 1 })
      if (!user) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      if (user.email === parsedEmail) {
        return res.status(400).json({ error: 'cannot_delete_primary_email' })
      }

      const emailExistsInAccount = user.emails?.some(e => e.email === parsedEmail)
      if (!emailExistsInAccount) {
        return res.status(404).json({ error: 'email_not_found' })
      }

      const auditLog = {
        initiatorId: userId,
        ipAddress: req.ip || '0.0.0.0',
        info: {},
      }

      const userUpdater = UserUpdater.promises || UserUpdater
      await userUpdater.removeEmailAddress(userId, parsedEmail, auditLog)

      const auditLogHandler =
        UserAuditLogHandler.promises || UserAuditLogHandler
      await auditLogHandler.addEntry(
        new ObjectId(userId),
        'remove-email',
        userId,
        req.ip || '0.0.0.0',
        { email: parsedEmail }
      )

      return res.status(200).json({ success: true })
    } catch (err) {
      if (err.message === 'cannot remove primary email') {
        return res.status(400).json({ error: 'cannot_delete_primary_email' })
      }
      logger.error(
        { err, sessionUserId: SessionManager.getLoggedInUserId(req.session), body: req.body },
        'Failed to delete secondary email'
      )
      return res.status(500).json({ error: 'failed_to_delete_email' })
    }
  },
}

export default AdminUserSelfServiceEmailsController
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && npx vitest run modules/admin-user-management/test/unit/src/AdminUserSelfServiceEmails.test.mjs
```
Expected: PASS (all 11 unit tests passing)

- [ ] **Step 5: Commit**

```bash
git add overleaf/services/web/modules/admin-user-management/app/src/AdminUserSelfServiceEmailsController.mjs overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserSelfServiceEmails.test.mjs
git commit -m "feat(admin-user-management): add self-service secondary emails controller"
```

---

### Task 2: Mount Endpoints & Expose Feature Flag in Express Locals and Views

**Files:**
- Modify: `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs:1-40`
- Modify: `overleaf/services/web/app/src/infrastructure/ExpressLocals.mjs:367-385`
- Modify: `overleaf/services/web/app/views/layout-base.pug:70-80`
- Modify: `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserManagementRouter.test.mjs`

**Interfaces:**
- Produces:
  - `POST /user/emails/secondary` mounted with `AuthenticationController.requireLogin()`
  - `POST /user/emails/default` mounted with `AuthenticationController.requireLogin()` (when affiliations disabled)
  - `POST /user/emails/delete` mounted with `AuthenticationController.requireLogin()` (when affiliations disabled)
  - `res.locals.ExposedSettings.hasAdminUserManagement: boolean`
  - Meta tag `ol-adminUserManagementEnabled` in `layout-base.pug`
- Consumes:
  - `AdminUserSelfServiceEmailsController`
  - `AuthenticationController.requireLogin()`
  - `Features.hasFeature('admin-user-management')`
  - `Features.hasFeature('affiliations')`

- [ ] **Step 1: Write failing test in AdminUserManagementRouter.test.mjs**

Update `overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserManagementRouter.test.mjs` to add tests verifying the registration of `/user/emails/secondary`, `/user/emails/default`, and `/user/emails/delete` using `AuthenticationController.requireLogin()`:

```javascript
// Add mock for AuthenticationController at top of file
vi.mock('../../../../../app/src/Features/Authentication/AuthenticationController.mjs', () => ({
  default: {
    requireLogin: vi.fn(() => (req, res, next) => next()),
  },
}))

vi.mock('../../../app/src/AdminUserSelfServiceEmailsController.mjs', () => ({
  default: {
    addSecondaryEmail: vi.fn(),
    setDefaultEmail: vi.fn(),
    deleteSecondaryEmail: vi.fn(),
  },
}))
```

Add test case in `describe('AdminUserManagementRouter', ...)`:
```javascript
  it('registers self-service email routes with requireLogin when admin-user-management is enabled and affiliations is disabled', () => {
    Features.hasFeature.mockImplementation(feature => {
      if (feature === 'admin-user-management') return true
      if (feature === 'affiliations') return false
      return false
    })
    const mockWebRouter = {
      get: vi.fn(),
      post: vi.fn(),
    }

    AdminUserManagementRouter.apply(mockWebRouter)

    const postCalls = mockWebRouter.post.mock.calls
    const postPaths = postCalls.map(call => call[0])

    expect(postPaths).toContain('/user/emails/secondary')
    expect(postPaths).toContain('/user/emails/default')
    expect(postPaths).toContain('/user/emails/delete')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && npx vitest run modules/admin-user-management/test/unit/src/AdminUserManagementRouter.test.mjs
```
Expected: FAIL with `expected postPaths to contain '/user/emails/secondary'`

- [ ] **Step 3: Update AdminUserManagementRouter.mjs, ExpressLocals.mjs, and layout-base.pug**

1. In `overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs`:
Add imports:
```javascript
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AdminUserSelfServiceEmailsController from './AdminUserSelfServiceEmailsController.mjs'
```

And in `apply(webRouter)`:
```javascript
    // Self-Service Secondary Emails for Community Edition
    webRouter.post(
      '/user/emails/secondary',
      rateLimit,
      AuthenticationController.requireLogin(),
      AdminUserSelfServiceEmailsController.addSecondaryEmail
    )

    if (!Features.hasFeature('affiliations')) {
      webRouter.post(
        '/user/emails/default',
        rateLimit,
        AuthenticationController.requireLogin(),
        AdminUserSelfServiceEmailsController.setDefaultEmail
      )

      webRouter.post(
        '/user/emails/delete',
        rateLimit,
        AuthenticationController.requireLogin(),
        AdminUserSelfServiceEmailsController.deleteSecondaryEmail
      )
    }
```

2. In `overleaf/services/web/app/src/infrastructure/ExpressLocals.mjs`:
Add `hasAdminUserManagement: Features.hasFeature('admin-user-management'),` to `res.locals.ExposedSettings`:
```javascript
      hasAffiliationsFeature: Features.hasFeature('affiliations'),
      hasAdminUserManagement: Features.hasFeature('admin-user-management'),
```

3. In `overleaf/services/web/app/views/layout-base.pug` (around line 77):
Add meta tag for `ol-adminUserManagementEnabled`:
```pug
				meta(
					name='ol-adminUserManagementEnabled'
					data-type='boolean'
					content=hasFeature('admin-user-management')
				)
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && npx vitest run modules/admin-user-management/test/unit/src/AdminUserManagementRouter.test.mjs
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add overleaf/services/web/modules/admin-user-management/app/src/AdminUserManagementRouter.mjs overleaf/services/web/modules/admin-user-management/test/unit/src/AdminUserManagementRouter.test.mjs overleaf/services/web/app/src/infrastructure/ExpressLocals.mjs overleaf/services/web/app/views/layout-base.pug
git commit -m "feat(admin-user-management): route self-service emails and expose feature flags"
```

---

### Task 3: Create Simplified Email Frontend Components

**Files:**
- Create: `overleaf/services/web/frontend/js/features/settings/components/emails/simple-emails-header.tsx`
- Create: `overleaf/services/web/frontend/js/features/settings/components/emails/simple-emails-row.tsx`
- Create: `overleaf/services/web/frontend/js/features/settings/components/emails/simple-add-email-form.tsx`
- Create: `overleaf/services/web/frontend/js/features/settings/components/emails/simple-emails.spec.tsx`

**Interfaces:**
- Produces:
  - `<SimpleEmailsHeader />`: 2-column header with Email (lg=8) and Actions (lg=4).
  - `<SimpleEmailsRow userEmailData={userEmail} primary={primary} />`: Clean email row showing email, primary badge, make primary button with confirmation modal, and delete button.
  - `<SimpleAddEmailForm />`: Clean inline input form with Add and Cancel buttons, auto-confirmation feedback on submit to `/user/emails/secondary`.
- Consumes:
  - `useUserEmailsContext()` (`getEmails`, `makePrimary`, `deleteEmail`, `state`)
  - `postJSON` from `@/infrastructure/fetch-json`
  - `OLRow`, `OLCol`, `OLBadge`, `OLButton`, `OLFormControl`, `OLForm`, `OLNotification`, `OLTooltip`

- [ ] **Step 1: Write component unit tests for SimpleEmailsHeader, SimpleEmailsRow, and SimpleAddEmailForm**

Create `overleaf/services/web/frontend/js/features/settings/components/emails/simple-emails.spec.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import * as FetchJson from '@/infrastructure/fetch-json'
import SimpleEmailsHeader from './simple-emails-header'
import SimpleEmailsRow from './simple-emails-row'
import SimpleAddEmailForm from './simple-add-email-form'
import { UserEmailsContext } from '../../context/user-email-context'
import { UserEmailData } from '../../../../../../types/user-email'

const mockContextValue = (overrides = {}) => ({
  state: {
    isLoading: false,
    data: {
      byId: {},
      emailCount: 2,
      linkedInstitutionIds: [],
      emailAffiliationBeingEdited: null,
    },
  },
  isInitializing: false,
  isInitializingSuccess: true,
  isInitializingError: false,
  getEmails: sinon.stub(),
  setLoading: sinon.stub(),
  makePrimary: sinon.stub(),
  deleteEmail: sinon.stub(),
  ...overrides,
})

describe('SimpleEmailsHeader', () => {
  it('renders Email and Actions columns without institution_and_role', () => {
    render(<SimpleEmailsHeader />)
    expect(screen.getByText('Email')).to.exist
    expect(screen.getByText('Actions')).to.exist
    expect(screen.queryByText('Institution and role')).to.not.exist
  })
})

describe('SimpleEmailsRow', () => {
  const primaryEmail: UserEmailData = {
    email: 'primary@example.com',
    default: true,
    confirmedAt: new Date().toISOString(),
  }

  const secondaryEmail: UserEmailData = {
    email: 'secondary@example.com',
    default: false,
    confirmedAt: new Date().toISOString(),
  }

  it('renders primary email with Primary badge and disabled delete button', () => {
    const ctx = mockContextValue()
    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleEmailsRow userEmailData={primaryEmail} primary={primaryEmail} />
      </UserEmailsContext.Provider>
    )

    expect(screen.getByText('primary@example.com')).to.exist
    expect(screen.getByText('Primary')).to.exist
    expect(screen.queryByText('Make primary')).to.not.exist
  })

  it('renders secondary email with Make primary button and delete button', () => {
    const ctx = mockContextValue()
    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleEmailsRow userEmailData={secondaryEmail} primary={primaryEmail} />
      </UserEmailsContext.Provider>
    )

    expect(screen.getByText('secondary@example.com')).to.exist
    expect(screen.getByText('Make primary')).to.exist
  })
})

describe('SimpleAddEmailForm', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('shows "+ Add another email" button initially', () => {
    const ctx = mockContextValue()
    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleAddEmailForm />
      </UserEmailsContext.Provider>
    )

    expect(screen.getByText('Add another email')).to.exist
  })

  it('expands form on click and submits to /user/emails/secondary', async () => {
    const postJsonStub = sinon.stub(FetchJson, 'postJSON').resolves({
      success: true,
      email: 'new@example.com',
    })
    const getEmailsStub = sinon.stub()
    const ctx = mockContextValue({ getEmails: getEmailsStub })

    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleAddEmailForm />
      </UserEmailsContext.Provider>
    )

    fireEvent.click(screen.getByText('Add another email'))

    const input = screen.getByPlaceholderText('name@example.com')
    expect(input).to.exist

    fireEvent.change(input, { target: { value: 'new@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add email' }))

    await waitFor(() => {
      expect(postJsonStub.calledWith('/user/emails/secondary', {
        body: { email: 'new@example.com' },
      })).to.be.true
      expect(getEmailsStub.calledOnce).to.be.true
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && yarn run test:frontend --grep "SimpleEmails"
```
Expected: FAIL with missing component files.

- [ ] **Step 3: Implement SimpleEmailsHeader.tsx**

Create `overleaf/services/web/frontend/js/features/settings/components/emails/simple-emails-header.tsx`:

```tsx
import { useTranslation } from 'react-i18next'
import EmailCell from './cell'
import OLCol from '@/shared/components/ol/ol-col'
import OLRow from '@/shared/components/ol/ol-row'
import classnames from 'classnames'

function SimpleEmailsHeader() {
  const { t } = useTranslation()

  return (
    <>
      <OLRow>
        <OLCol lg={8} className="d-none d-sm-block">
          <EmailCell>
            <strong>{t('email', 'Email')}</strong>
          </EmailCell>
        </OLCol>
        <OLCol lg={4} className="d-none d-sm-block text-lg-end">
          <EmailCell>
            <strong>{t('actions', 'Actions')}</strong>
          </EmailCell>
        </OLCol>
      </OLRow>
      <div className={classnames('d-none d-sm-block', 'horizontal-divider')} />
      <div className={classnames('d-none d-sm-block', 'horizontal-divider')} />
    </>
  )
}

export default SimpleEmailsHeader
```

- [ ] **Step 4: Implement SimpleEmailsRow.tsx**

Create `overleaf/services/web/frontend/js/features/settings/components/emails/simple-emails-row.tsx`:

```tsx
import { useTranslation } from 'react-i18next'
import { UserEmailData } from '../../../../../../types/user-email'
import EmailCell from './cell'
import Actions from './actions'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import OLBadge from '@/shared/components/ol/ol-badge'

type SimpleEmailsRowProps = {
  userEmailData: UserEmailData
  primary?: UserEmailData
}

function SimpleEmailsRow({ userEmailData, primary }: SimpleEmailsRowProps) {
  const { t } = useTranslation()
  const isPrimary = userEmailData.default

  return (
    <OLRow data-testid="simple-email-row" className="align-items-center py-2">
      <OLCol lg={8}>
        <EmailCell>
          <span className="me-2">{userEmailData.email}</span>
          {isPrimary && (
            <OLBadge bg="info">{t('primary', 'Primary')}</OLBadge>
          )}
          {!userEmailData.confirmedAt && (
            <span className="text-muted small ms-2">
              ({t('unconfirmed', 'Unconfirmed')})
            </span>
          )}
        </EmailCell>
      </OLCol>
      <OLCol lg={4}>
        <EmailCell className="text-lg-end">
          <Actions userEmailData={userEmailData} primary={primary} />
        </EmailCell>
      </OLCol>
    </OLRow>
  )
}

export default SimpleEmailsRow
```

- [ ] **Step 5: Implement SimpleAddEmailForm.tsx**

Create `overleaf/services/web/frontend/js/features/settings/components/emails/simple-add-email-form.tsx`:

```tsx
import { useState, type FormEvent } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { useUserEmailsContext } from '../../context/user-email-context'
import { postJSON } from '../../../../infrastructure/fetch-json'
import useAsync from '../../../../shared/hooks/use-async'
import getMeta from '../../../../utils/meta'
import { isValidEmail } from '../../../../shared/utils/email'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLNotification from '@/shared/components/ol/ol-notification'
import AddAnotherEmailBtn from './add-email/add-another-email-btn'

function SimpleAddEmailForm() {
  const { t } = useTranslation()
  const [isFormVisible, setIsFormVisible] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const { isLoading, runAsync } = useAsync()
  const { state, getEmails } = useUserEmailsContext()

  const emailAddressLimit = getMeta('ol-emailAddressLimit') || 10

  const handleOpenForm = () => {
    setIsFormVisible(true)
    setErrorMessage(null)
    setSuccessMessage(null)
  }

  const handleCancel = () => {
    setIsFormVisible(false)
    setNewEmail('')
    setErrorMessage(null)
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = newEmail.trim()
    if (!trimmed || !isValidEmail(trimmed)) {
      setErrorMessage(t('invalid_email_format', 'Please enter a valid email address.'))
      return
    }

    setErrorMessage(null)
    runAsync(
      postJSON('/user/emails/secondary', {
        body: { email: trimmed },
      })
    )
      .then(() => {
        setSuccessMessage(
          t('email_added_successfully', 'Secondary email added successfully.')
        )
        setNewEmail('')
        setIsFormVisible(false)
        getEmails()
      })
      .catch((err: any) => {
        const errorKey = err?.data?.error
        if (errorKey === 'email_already_registered') {
          setErrorMessage(
            t('email_already_registered', 'This email address is already registered.')
          )
        } else if (errorKey === 'email_limit_exceeded') {
          setErrorMessage(
            t('email_limit_reached', 'Email address limit reached.')
          )
        } else {
          setErrorMessage(
            t('error_performing_request', 'An error occurred while adding email.')
          )
        }
      })
  }

  if (!isFormVisible) {
    return (
      <div className="mt-3">
        {successMessage && (
          <div className="mb-2">
            <OLNotification type="success" content={successMessage} />
          </div>
        )}
        {state.data.emailCount >= emailAddressLimit ? (
          <p className="small text-muted mb-0">
            <Trans
              i18nKey="email_limit_reached"
              values={{ emailAddressLimit }}
              shouldUnescape
              components={[<strong key="0" />]}
            />
          </p>
        ) : (
          <AddAnotherEmailBtn onClick={handleOpenForm} />
        )}
      </div>
    )
  }

  return (
    <div className="mt-3 p-3 bg-light rounded border">
      {errorMessage && (
        <div className="mb-3">
          <OLNotification type="error" content={errorMessage} />
        </div>
      )}
      <OLForm onSubmit={handleSubmit}>
        <OLFormGroup className="mb-3">
          <label htmlFor="simple-secondary-email-input" className="form-label fw-bold small">
            {t('email_address', 'Email Address')}
          </label>
          <OLFormControl
            id="simple-secondary-email-input"
            type="email"
            placeholder="name@example.com"
            value={newEmail}
            onChange={(e: any) => setNewEmail(e.target.value)}
            disabled={isLoading}
            autoFocus
          />
        </OLFormGroup>
        <div className="d-flex gap-2">
          <OLButton
            variant="primary"
            type="submit"
            disabled={!newEmail.trim() || isLoading}
            isLoading={isLoading}
          >
            {t('add_email', 'Add email')}
          </OLButton>
          <OLButton
            variant="secondary"
            type="button"
            onClick={handleCancel}
            disabled={isLoading}
          >
            {t('cancel', 'Cancel')}
          </OLButton>
        </div>
      </OLForm>
    </div>
  )
}

export default SimpleAddEmailForm
```

- [ ] **Step 6: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && yarn run test:frontend --grep "SimpleEmails"
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add overleaf/services/web/frontend/js/features/settings/components/emails/simple-emails-header.tsx overleaf/services/web/frontend/js/features/settings/components/emails/simple-emails-row.tsx overleaf/services/web/frontend/js/features/settings/components/emails/simple-add-email-form.tsx overleaf/services/web/frontend/js/features/settings/components/emails/simple-emails.spec.tsx
git commit -m "feat(settings): create simple email components for CE secondary emails"
```

---

### Task 4: Integrate Simple Components into Settings EmailsSection

**Files:**
- Modify: `overleaf/services/web/frontend/js/features/settings/components/emails-section.tsx`
- Create: `overleaf/services/web/frontend/js/features/settings/components/emails-section.spec.tsx`

**Interfaces:**
- Produces:
  - `<EmailsSection />` renders simplified view when `hasAdminUserManagement` (or `ol-adminUserManagementEnabled`) is true and `hasAffiliationsFeature` is false.
  - Retains standard affiliations view when `hasAffiliationsFeature` is true.
  - Returns `null` when neither feature is enabled.
- Consumes:
  - `getMeta('ol-ExposedSettings')`
  - `getMeta('ol-adminUserManagementEnabled')`
  - `SimpleEmailsHeader`, `SimpleEmailsRow`, `SimpleAddEmailForm`
  - `EmailsHeader`, `EmailsRow`, `AddEmail`

- [ ] **Step 1: Write unit test for EmailsSection feature switching**

Create `overleaf/services/web/frontend/js/features/settings/components/emails-section.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import * as MetaUtil from '../../../utils/meta'
import EmailsSection from './emails-section'

describe('EmailsSection feature gating', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('returns null when both affiliations and adminUserManagement are disabled', () => {
    sinon.stub(MetaUtil, 'default').callsFake((key: string) => {
      if (key === 'ol-ExposedSettings') {
        return { hasAffiliationsFeature: false, hasAdminUserManagement: false }
      }
      if (key === 'ol-adminUserManagementEnabled') return false
      return null
    })

    const { container } = render(<EmailsSection />)
    expect(container.firstChild).to.be.null
  })

  it('renders simplified emails interface when adminUserManagement is enabled and affiliations is disabled', () => {
    sinon.stub(MetaUtil, 'default').callsFake((key: string) => {
      if (key === 'ol-ExposedSettings') {
        return { hasAffiliationsFeature: false, hasAdminUserManagement: true }
      }
      if (key === 'ol-adminUserManagementEnabled') return true
      return null
    })

    render(<EmailsSection />)
    expect(screen.getByText('Emails')).to.exist
    expect(screen.queryByText('Emails and affiliations')).to.not.exist
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd overleaf/services/web && yarn run test:frontend --grep "EmailsSection feature gating"
```
Expected: FAIL because `EmailsSection` currently checks only `hasAffiliationsFeature`.

- [ ] **Step 3: Update emails-section.tsx**

Modify `overleaf/services/web/frontend/js/features/settings/components/emails-section.tsx`:

```tsx
import { Fragment } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import getMeta from '../../../utils/meta'
import {
  UserEmailsProvider,
  useUserEmailsContext,
} from '../context/user-email-context'
import EmailsHeader from './emails/header'
import EmailsRow from './emails/row'
import AddEmail from './emails/add-email'
import SimpleEmailsHeader from './emails/simple-emails-header'
import SimpleEmailsRow from './emails/simple-emails-row'
import SimpleAddEmailForm from './emails/simple-add-email-form'
import OLNotification from '@/shared/components/ol/ol-notification'
import LoadingSpinner from '@/shared/components/loading-spinner'

type EmailsSectionContentProps = {
  isSimpleMode: boolean
}

function EmailsSectionContent({ isSimpleMode }: EmailsSectionContentProps) {
  const { t } = useTranslation()
  const {
    state: { data: userEmailsData },
    isInitializing,
    isInitializingError,
    isInitializingSuccess,
  } = useUserEmailsContext()
  const userEmails = Object.values(userEmailsData.byId)
  const primary = userEmails.find(userEmail => userEmail.default)

  const hideAddSecondaryEmail = getMeta('ol-cannot-add-secondary-email')

  const sortedUserEmails = [...userEmails].sort((a, b) => {
    if (a.default) return -1
    if (b.default) return 1
    if (a.confirmedAt && !b.confirmedAt) return -1
    if (!a.confirmedAt && b.confirmedAt) return 1
    return a.email.localeCompare(b.email)
  })

  if (isSimpleMode) {
    return (
      <>
        <h2 className="h3">{t('emails', 'Emails')}</h2>
        <p className="small">
          {t(
            'emails_explanation',
            'Add additional email addresses to your account to make sure you can recover your account and collaborators can find you.'
          )}
        </p>
        <>
          <SimpleEmailsHeader />
          {isInitializing ? (
            <div className="affiliations-table-row-highlighted">
              <div className="affiliations-table-cell text-center">
                <LoadingSpinner size="sm" />
              </div>
            </div>
          ) : (
            <>
              {sortedUserEmails.map(userEmail => (
                <Fragment key={userEmail.email}>
                  <SimpleEmailsRow userEmailData={userEmail} primary={primary} />
                  <div className="horizontal-divider" />
                </Fragment>
              ))}
            </>
          )}
          {isInitializingSuccess && !hideAddSecondaryEmail && <SimpleAddEmailForm />}
          {isInitializingError && (
            <OLNotification
              type="error"
              content={t('error_performing_request')}
            />
          )}
        </>
      </>
    )
  }

  return (
    <>
      <h2 className="h3">{t('emails_and_affiliations_title')}</h2>
      <p className="small">{t('emails_and_affiliations_explanation')}</p>
      <p className="small">
        <Trans
          i18nKey="change_primary_email_address_instructions"
          components={[
            <strong key="0" />,
            <a
              key="1"
              href="/learn/how-to/Managing_your_Overleaf_emails"
              target="_blank"
              rel="noreferrer"
            />,
          ]}
        />
      </p>
      <>
        <EmailsHeader />
        {isInitializing ? (
          <div className="affiliations-table-row-highlighted">
            <div className="affiliations-table-cell text-center">
              <LoadingSpinner size="sm" />
            </div>
          </div>
        ) : (
          <>
            {sortedUserEmails.map(userEmail => (
              <Fragment key={userEmail.email}>
                <EmailsRow userEmailData={userEmail} primary={primary} />
                <div className="horizontal-divider" />
              </Fragment>
            ))}
          </>
        )}
        {isInitializingSuccess && !hideAddSecondaryEmail && <AddEmail />}
        {isInitializingError && (
          <OLNotification
            type="error"
            content={t('error_performing_request')}
          />
        )}
      </>
    </>
  )
}

function EmailsSection() {
  const exposedSettings = getMeta('ol-ExposedSettings') || {}
  const hasAffiliationsFeature = Boolean(exposedSettings.hasAffiliationsFeature)
  const hasAdminUserManagement = Boolean(
    exposedSettings.hasAdminUserManagement ||
    getMeta('ol-adminUserManagementEnabled')
  )

  if (!hasAffiliationsFeature && !hasAdminUserManagement) {
    return null
  }

  const isSimpleMode = !hasAffiliationsFeature && hasAdminUserManagement

  return (
    <UserEmailsProvider>
      <EmailsSectionContent isSimpleMode={isSimpleMode} />
    </UserEmailsProvider>
  )
}

export default EmailsSection
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd overleaf/services/web && yarn run test:frontend --grep "EmailsSection feature gating"
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add overleaf/services/web/frontend/js/features/settings/components/emails-section.tsx overleaf/services/web/frontend/js/features/settings/components/emails-section.spec.tsx
git commit -m "feat(settings): render simplified emails UI when admin-user-management enabled without affiliations"
```

---

### Task 5: End-to-End Playwright Verification

**Files:**
- Create: `overleaf/test/playwright/specs/self-service-secondary-emails.spec.ts`

**Interfaces:**
- Produces:
  - Playwright test running against local Overleaf instance (`http://localhost/login` or configured `OVERLEAF_URL`)
  - Verification of:
    1. Login as user (`dangdoan2206@gmail.com`).
    2. Navigating to `/user/settings`.
    3. Absence of "Institution and role" header.
    4. Adding secondary email `test.secondary@example.com` with auto-confirmation.
    5. Setting secondary email as primary and verifying Primary badge updates.
    6. Deleting old email and verifying deletion.
    7. Screenshots saved to `overleaf/test/playwright/screenshots/`.

- [ ] **Step 1: Write Playwright E2E test script**

Create `overleaf/test/playwright/specs/self-service-secondary-emails.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.OVERLEAF_URL || 'http://localhost'
const USER_EMAIL = process.env.TEST_USER_EMAIL || 'dangdoan2206@gmail.com'
const USER_PASSWORD = process.env.TEST_USER_PASSWORD || 'password'
const SECONDARY_EMAIL = `test.secondary.${Date.now()}@example.com`

test.describe('Self-Service Secondary Emails in Overleaf CE', () => {
  test('adds, promotes to primary, and deletes a secondary email without affiliations', async ({ page }) => {
    // 1. Log in
    await page.goto(`${BASE_URL}/login`)
    await page.fill('input[name="email"], input[type="email"]', USER_EMAIL)
    await page.fill('input[name="password"], input[type="password"]', USER_PASSWORD)
    await page.click('button[type="submit"]')

    // Wait for navigation after login
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 })

    // 2. Navigate to Account Settings
    await page.goto(`${BASE_URL}/user/settings`)
    await page.waitForSelector('text=Emails', { timeout: 10000 })

    // Verify simplified table header
    await expect(page.locator('text=Emails and affiliations')).not.toBeVisible()
    await expect(page.locator('text=Institution and role')).not.toBeVisible()
    await expect(page.locator('strong:has-text("Email")')).toBeVisible()
    await expect(page.locator('strong:has-text("Actions")')).toBeVisible()

    // 3. Add a secondary email
    await page.click('button:has-text("Add another email")')
    await page.waitForSelector('#simple-secondary-email-input')
    await page.fill('#simple-secondary-email-input', SECONDARY_EMAIL)
    await page.click('button:has-text("Add email")')

    // 4. Verify email appears immediately confirmed
    await expect(page.locator(`text=${SECONDARY_EMAIL}`)).toBeVisible({ timeout: 10000 })
    await expect(page.locator(`text=${SECONDARY_EMAIL}`).locator('..').locator('text=Unconfirmed')).not.toBeVisible()

    // Capture screenshot of added secondary email
    await page.screenshot({
      path: 'overleaf/test/playwright/screenshots/secondary-email-added.png',
      fullPage: true,
    })

    // 5. Promote secondary email to Primary
    const secondaryRow = page.locator(`[data-testid="simple-email-row"]:has-text("${SECONDARY_EMAIL}")`)
    await secondaryRow.locator('button:has-text("Make primary")').click()

    // Confirm modal
    await page.waitForSelector('.modal-dialog')
    await page.click('.modal-dialog button:has-text("Make primary"), .modal-dialog button:has-text("Confirm")')

    // Verify Primary badge moved to secondary email
    await expect(secondaryRow.locator('text=Primary')).toBeVisible({ timeout: 10000 })

    // Capture screenshot of promoted email
    await page.screenshot({
      path: 'overleaf/test/playwright/screenshots/secondary-email-promoted.png',
      fullPage: true,
    })

    // 6. Delete old primary (which is now secondary)
    const oldPrimaryRow = page.locator(`[data-testid="simple-email-row"]:has-text("${USER_EMAIL}")`)
    await oldPrimaryRow.locator('button[aria-label="Remove"], button[aria-label="remove"]').click()

    // Verify old email disappeared from list
    await expect(page.locator(`text=${USER_EMAIL}`)).not.toBeVisible({ timeout: 10000 })

    // Capture screenshot after deletion
    await page.screenshot({
      path: 'overleaf/test/playwright/screenshots/secondary-email-deleted.png',
      fullPage: true,
    })
  })
})
```

- [ ] **Step 2: Run Playwright test and verify execution**

Run:
```bash
OVERLEAF_URL="http://localhost" npx playwright test overleaf/test/playwright/specs/self-service-secondary-emails.spec.ts
```
Expected: PASS and screenshots generated in `overleaf/test/playwright/screenshots/`.

- [ ] **Step 3: Commit**

```bash
git add overleaf/test/playwright/specs/self-service-secondary-emails.spec.ts
git commit -m "test(e2e): add Playwright verification for self-service secondary emails"
```
