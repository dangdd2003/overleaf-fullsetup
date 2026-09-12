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
