import { describe, it, expect, vi, beforeEach } from 'vitest'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserGetter from '../../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../../app/src/Features/User/UserUpdater.mjs'
import EmailHelper from '../../../../../app/src/Features/Helpers/EmailHelper.mjs'
import UserAuditLogHandler from '../../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import UserSessionsManager from '../../../../../app/src/Features/User/UserSessionsManager.mjs'
import UserEmailsConfirmationHandler from '../../../../../app/src/Features/User/UserEmailsConfirmationHandler.mjs'
import AdminUserSelfServiceEmailsController, {
  PENDING_EMAIL_SESSION_KEY,
} from '../../../app/src/AdminUserSelfServiceEmailsController.mjs'

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

vi.mock('../../../../../app/src/Features/User/UserEmailsConfirmationHandler.mjs', () => ({
  default: {
    promises: {
      sendConfirmationCode: vi.fn().mockResolvedValue({
        confirmCode: '123456',
        confirmCodeExpiresTimestamp: 9999999999999,
      }),
    },
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

    it('sends a code and stores only a hash of it in the session, without writing to the account', async () => {
      const { req, res } = createMockReqRes({ body: { email: 'secondary@example.com' } })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        email: 'primary@example.com',
        emails: [{ email: 'primary@example.com' }],
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserEmailsConfirmationHandler.promises.sendConfirmationCode.mockResolvedValue({
        confirmCode: '123456',
        confirmCodeExpiresTimestamp: 9999999999999,
      })

      await AdminUserSelfServiceEmailsController.addSecondaryEmail(req, res)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({
        success: true,
        email: 'secondary@example.com',
        confirmed: false,
      })
      expect(UserEmailsConfirmationHandler.promises.sendConfirmationCode).toHaveBeenCalledWith(
        'secondary@example.com',
        false
      )
      // Nothing is attached to the account until the code is confirmed
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
      expect(UserUpdater.promises.confirmEmail).not.toHaveBeenCalled()
      expect(UserAuditLogHandler.promises.addEntry).not.toHaveBeenCalled()

      const pending = req.session[PENDING_EMAIL_SESSION_KEY]
      expect(pending).toMatchObject({
        userId: '507f1f77bcf86cd799439011',
        email: 'secondary@example.com',
        attempts: 0,
      })
      expect(pending.expiresAt).toBeGreaterThan(Date.now())
      expect(JSON.stringify(pending)).not.toContain('123456')
    })
  })

  describe('confirmSecondaryEmail', () => {
    const userId = '507f1f77bcf86cd799439011'

    async function startPendingAdd(email = 'secondary@example.com') {
      const { req, res } = createMockReqRes({ body: { email } })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: userId,
        email: 'primary@example.com',
        emails: [{ email: 'primary@example.com' }],
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserEmailsConfirmationHandler.promises.sendConfirmationCode.mockResolvedValue({
        confirmCode: '123456',
        confirmCodeExpiresTimestamp: 9999999999999,
      })
      await AdminUserSelfServiceEmailsController.addSecondaryEmail(req, res)
      expect(res.statusCode).toBe(200)
      vi.clearAllMocks()
      return req
    }

    function confirmReq(session, code) {
      const { req, res } = createMockReqRes({ body: { code } })
      req.session = session
      return { req, res }
    }

    it('attaches and confirms the email only after the correct code', async () => {
      const addReq = await startPendingAdd()
      UserGetter.promises.getUser.mockResolvedValue({
        _id: userId,
        email: 'primary@example.com',
        emails: [{ email: 'primary@example.com' }],
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserUpdater.promises.addEmailAddress.mockResolvedValue()
      UserUpdater.promises.confirmEmail.mockResolvedValue()
      const { req, res } = confirmReq(addReq.session, '123456')

      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(req, res)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({
        success: true,
        email: 'secondary@example.com',
        confirmed: true,
        redir: '/user/settings',
      })
      expect(UserUpdater.promises.addEmailAddress).toHaveBeenCalledWith(
        userId,
        'secondary@example.com',
        {},
        expect.objectContaining({ initiatorId: userId })
      )
      expect(UserUpdater.promises.confirmEmail).toHaveBeenCalledWith(
        userId,
        'secondary@example.com'
      )
      expect(req.session[PENDING_EMAIL_SESSION_KEY]).toBeUndefined()
    })

    it('rejects a wrong code without writing to the account', async () => {
      const addReq = await startPendingAdd()
      const { req, res } = confirmReq(addReq.session, '000000')

      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(req, res)

      expect(res.statusCode).toBe(403)
      expect(res.body).toEqual({ message: { key: 'invalid_confirmation_code' } })
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
      expect(UserUpdater.promises.confirmEmail).not.toHaveBeenCalled()
      expect(req.session[PENDING_EMAIL_SESSION_KEY].attempts).toBe(1)
    })

    it('drops the pending entry after too many wrong codes', async () => {
      const addReq = await startPendingAdd()
      let last
      for (let i = 0; i < 5; i++) {
        last = confirmReq(addReq.session, '000000')
        await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(
          last.req,
          last.res
        )
      }

      expect(last.res.statusCode).toBe(429)
      expect(last.res.body).toEqual({ message: { key: 'too_many_confirm_code_verification_attempts' } })
      expect(addReq.session[PENDING_EMAIL_SESSION_KEY]).toBeUndefined()

      // Even the right code no longer works once the entry is gone
      const { req, res } = confirmReq(addReq.session, '123456')
      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(req, res)
      expect(res.statusCode).toBe(422)
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
    })

    it('rejects an expired code and removes the entry', async () => {
      const addReq = await startPendingAdd()
      addReq.session[PENDING_EMAIL_SESSION_KEY].expiresAt = Date.now() - 1
      const { req, res } = confirmReq(addReq.session, '123456')

      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(req, res)

      expect(res.statusCode).toBe(403)
      expect(res.body).toEqual({ message: { key: 'expired_confirmation_code' } })
      expect(req.session[PENDING_EMAIL_SESSION_KEY]).toBeUndefined()
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
    })

    it('returns 422 when there is no pending confirmation', async () => {
      const { req, res } = confirmReq({}, '123456')

      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(req, res)

      expect(res.statusCode).toBe(422)
      expect(res.body).toEqual({ message: { key: 'error_performing_request' } })
    })

    it('does not accept a pending entry created for another user', async () => {
      const addReq = await startPendingAdd()
      const { req, res } = confirmReq(addReq.session, '123456')
      SessionManager.getLoggedInUserId.mockReturnValue('507f1f77bcf86cd799439099')

      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(req, res)

      expect(res.statusCode).toBe(422)
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
    })

    it('treats a code as single use', async () => {
      const addReq = await startPendingAdd()
      UserGetter.promises.getUser.mockResolvedValue({
        _id: userId,
        emails: [{ email: 'primary@example.com' }],
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserUpdater.promises.addEmailAddress.mockResolvedValue()
      UserUpdater.promises.confirmEmail.mockResolvedValue()
      const first = confirmReq(addReq.session, '123456')
      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(first.req, first.res)
      expect(first.res.statusCode).toBe(200)

      const second = confirmReq(addReq.session, '123456')
      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(second.req, second.res)
      expect(second.res.statusCode).toBe(422)
      expect(UserUpdater.promises.addEmailAddress).toHaveBeenCalledTimes(1)
    })

    it('checks again that the address is free at confirm time', async () => {
      const addReq = await startPendingAdd()
      UserGetter.promises.getUser.mockResolvedValue({
        _id: userId,
        emails: [{ email: 'primary@example.com' }],
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue({
        _id: 'other-user-id',
      })
      const { req, res } = confirmReq(addReq.session, '123456')

      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(req, res)

      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual({ message: { key: 'email_already_registered' } })
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
      expect(UserUpdater.promises.confirmEmail).not.toHaveBeenCalled()
    })

    it('returns 409 when the add races with another claim', async () => {
      const addReq = await startPendingAdd()
      UserGetter.promises.getUser.mockResolvedValue({
        _id: userId,
        emails: [{ email: 'primary@example.com' }],
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      const err = new Error('email exists')
      err.name = 'EmailExistsError'
      UserUpdater.promises.addEmailAddress.mockRejectedValue(err)
      const { req, res } = confirmReq(addReq.session, '123456')

      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(req, res)

      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual({ message: { key: 'email_already_registered' } })
      expect(UserUpdater.promises.confirmEmail).not.toHaveBeenCalled()
    })
  })

  describe('resendSecondaryEmailConfirmationCode', () => {
    const userId = '507f1f77bcf86cd799439011'

    async function startPendingAdd() {
      const { req, res } = createMockReqRes({
        body: { email: 'secondary@example.com' },
      })
      UserGetter.promises.getUser.mockResolvedValue({
        _id: userId,
        emails: [{ email: 'primary@example.com' }],
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserEmailsConfirmationHandler.promises.sendConfirmationCode.mockResolvedValue({
        confirmCode: '123456',
        confirmCodeExpiresTimestamp: 9999999999999,
      })
      await AdminUserSelfServiceEmailsController.addSecondaryEmail(req, res)
      vi.clearAllMocks()
      return req.session
    }

    it('sends a new code, replaces the stored hash and resets attempts and expiry', async () => {
      const session = await startPendingAdd()
      session[PENDING_EMAIL_SESSION_KEY].attempts = 4
      session[PENDING_EMAIL_SESSION_KEY].expiresAt = Date.now() + 1000
      const oldHash = session[PENDING_EMAIL_SESSION_KEY].codeHash
      UserEmailsConfirmationHandler.promises.sendConfirmationCode.mockResolvedValue({
        confirmCode: '654321',
        confirmCodeExpiresTimestamp: 9999999999999,
      })
      const { req, res } = createMockReqRes({})
      req.session = session

      await AdminUserSelfServiceEmailsController.resendSecondaryEmailConfirmationCode(req, res)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ message: { key: 'we_sent_new_code' } })
      expect(UserEmailsConfirmationHandler.promises.sendConfirmationCode).toHaveBeenCalledWith(
        'secondary@example.com',
        false
      )
      const pending = session[PENDING_EMAIL_SESSION_KEY]
      expect(pending.attempts).toBe(0)
      expect(pending.expiresAt).toBeGreaterThan(Date.now() + 5 * 60 * 1000)
      expect(pending.codeHash).not.toBe(oldHash)
      expect(JSON.stringify(pending)).not.toContain('654321')
      expect(UserUpdater.promises.addEmailAddress).not.toHaveBeenCalled()
    })

    it('makes the previous code invalid and the new one usable', async () => {
      const session = await startPendingAdd()
      UserEmailsConfirmationHandler.promises.sendConfirmationCode.mockResolvedValue({
        confirmCode: '654321',
        confirmCodeExpiresTimestamp: 9999999999999,
      })
      const resend = createMockReqRes({})
      resend.req.session = session
      await AdminUserSelfServiceEmailsController.resendSecondaryEmailConfirmationCode(resend.req, resend.res)

      UserGetter.promises.getUser.mockResolvedValue({
        _id: userId,
        emails: [{ email: 'primary@example.com' }],
      })
      UserGetter.promises.getUserByAnyEmail.mockResolvedValue(null)
      UserUpdater.promises.addEmailAddress.mockResolvedValue()
      UserUpdater.promises.confirmEmail.mockResolvedValue()

      const oldCode = createMockReqRes({ body: { code: '123456' } })
      oldCode.req.session = session
      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(oldCode.req, oldCode.res)
      expect(oldCode.res.statusCode).toBe(403)

      const newCode = createMockReqRes({ body: { code: '654321' } })
      newCode.req.session = session
      await AdminUserSelfServiceEmailsController.confirmSecondaryEmail(newCode.req, newCode.res)
      expect(newCode.res.statusCode).toBe(200)
    })

    it('keeps the existing entry when the code cannot be sent', async () => {
      const session = await startPendingAdd()
      session[PENDING_EMAIL_SESSION_KEY].attempts = 3
      const before = { ...session[PENDING_EMAIL_SESSION_KEY] }
      UserEmailsConfirmationHandler.promises.sendConfirmationCode.mockRejectedValue(new Error('smtp down'))
      const { req, res } = createMockReqRes({})
      req.session = session

      await AdminUserSelfServiceEmailsController.resendSecondaryEmailConfirmationCode(req, res)

      expect(res.statusCode).toBe(500)
      expect(res.body).toEqual({ message: { key: 'error_performing_request' } })
      expect(session[PENDING_EMAIL_SESSION_KEY]).toEqual(before)
    })

    it('returns 422 when there is no pending entry for this user', async () => {
      const { req, res } = createMockReqRes({})
      req.session = {}

      await AdminUserSelfServiceEmailsController.resendSecondaryEmailConfirmationCode(req, res)

      expect(res.statusCode).toBe(422)
      expect(res.body).toEqual({ message: { key: 'error_performing_request' } })
      expect(UserEmailsConfirmationHandler.promises.sendConfirmationCode).not.toHaveBeenCalled()
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
