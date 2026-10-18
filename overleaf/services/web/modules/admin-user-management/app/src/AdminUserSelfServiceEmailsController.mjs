import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../app/src/Features/User/UserUpdater.mjs'
import UserSessionsManager from '../../../../app/src/Features/User/UserSessionsManager.mjs'
import UserEmailsConfirmationHandler from '../../../../app/src/Features/User/UserEmailsConfirmationHandler.mjs'
import EmailHelper from '../../../../app/src/Features/Helpers/EmailHelper.mjs'
import UserAuditLogHandler from '../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'

// A new secondary email is held in the session until its confirmation code is
// entered. The address is only written to the account after that point.
export const PENDING_EMAIL_SESSION_KEY = 'adminSelfServicePendingEmail'
export const CONFIRMATION_CODE_TTL_MS = 10 * 60 * 1000
export const MAX_CONFIRMATION_ATTEMPTS = 5

function hashCode(salt, code) {
  return crypto.createHash('sha256').update(salt).update(code).digest('hex')
}

// Sends a fresh code and returns the session fields that hold it (hash only)
async function issueConfirmationCode(email) {
  const { confirmCode } =
    await UserEmailsConfirmationHandler.promises.sendConfirmationCode(
      email,
      false
    )
  const codeSalt = crypto.randomBytes(16).toString('hex')
  return {
    codeSalt,
    codeHash: hashCode(codeSalt, confirmCode),
    expiresAt: Date.now() + CONFIRMATION_CODE_TTL_MS,
    attempts: 0,
  }
}

// Error body shape read by the upstream ConfirmEmailForm
function messageBody(key) {
  return { message: { key } }
}

function codeMatches(pending, code) {
  const candidate = Buffer.from(hashCode(pending.codeSalt, code), 'hex')
  const expected = Buffer.from(pending.codeHash, 'hex')
  return (
    candidate.length === expected.length &&
    crypto.timingSafeEqual(candidate, expected)
  )
}

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

      const existingUser = await userGetter.getUserByAnyEmail(parsedEmail)
      if (existingUser) {
        return res.status(409).json({ error: 'email_already_registered' })
      }

      // Nothing is written to the account here. The address is attached by
      // confirmSecondaryEmail once the code sent to it has been entered.
      req.session[PENDING_EMAIL_SESSION_KEY] = {
        userId,
        email: parsedEmail,
        ...(await issueConfirmationCode(parsedEmail)),
      }

      return res.status(200).json({
        success: true,
        email: parsedEmail,
        confirmed: false,
      })
    } catch (err) {
      logger.error(
        { err, sessionUserId: SessionManager.getLoggedInUserId(req.session), body: req.body },
        'Failed to send secondary email confirmation code'
      )
      return res.status(500).json({ error: 'failed_to_add_email' })
    }
  },

  async confirmSecondaryEmail(req, res) {
    try {
      const userId = SessionManager.getLoggedInUserId(req.session)
      if (!userId) {
        return res.status(401).json({ error: 'unauthorized' })
      }

      const pending = req.session[PENDING_EMAIL_SESSION_KEY]
      if (!pending || pending.userId !== userId) {
        return res
          .status(422)
          .json(messageBody('error_performing_request'))
      }

      if (Date.now() > pending.expiresAt) {
        delete req.session[PENDING_EMAIL_SESSION_KEY]
        return res
          .status(403)
          .json(messageBody('expired_confirmation_code'))
      }

      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
      if (!codeMatches(pending, code)) {
        pending.attempts += 1
        if (pending.attempts >= MAX_CONFIRMATION_ATTEMPTS) {
          delete req.session[PENDING_EMAIL_SESSION_KEY]
          return res
            .status(429)
            .json(messageBody('too_many_confirm_code_verification_attempts'))
        }
        return res
          .status(403)
          .json(messageBody('invalid_confirmation_code'))
      }

      // Single use: the pending entry is removed before any write
      delete req.session[PENDING_EMAIL_SESSION_KEY]
      const parsedEmail = pending.email

      const userGetter = UserGetter.promises || UserGetter
      const user = await userGetter.getUser(userId, { emails: 1, email: 1 })
      if (!user) {
        return res.status(404).json(messageBody('error_performing_request'))
      }

      const emailLimit = Settings.emailAddressLimit || 10
      if (user.emails && user.emails.length >= emailLimit) {
        return res.status(422).json(messageBody('error_performing_request'))
      }

      // Checked again at confirm time: the address may have been claimed since
      const existingUser = await userGetter.getUserByAnyEmail(parsedEmail)
      if (existingUser) {
        return res.status(409).json(messageBody('email_already_registered'))
      }

      const userUpdater = UserUpdater.promises || UserUpdater
      const auditLog = {
        initiatorId: userId,
        ipAddress: req.ip || '0.0.0.0',
        info: {},
      }
      // addEmailAddress writes the 'add-email' audit entry itself
      await userUpdater.addEmailAddress(userId, parsedEmail, {}, auditLog)
      await userUpdater.confirmEmail(userId, parsedEmail)

      return res.status(200).json({
        success: true,
        email: parsedEmail,
        confirmed: true,
        redir: '/user/settings',
      })
    } catch (err) {
      if (
        err.name === 'EmailExistsError' ||
        err.message?.includes('already registered') ||
        err.message?.includes('already exists')
      ) {
        return res.status(409).json(messageBody('email_already_registered'))
      }
      logger.error(
        { err, sessionUserId: SessionManager.getLoggedInUserId(req.session) },
        'Failed to confirm self-service secondary email'
      )
      return res.status(500).json(messageBody('error_performing_request'))
    }
  },

  async resendSecondaryEmailConfirmationCode(req, res) {
    try {
      const userId = SessionManager.getLoggedInUserId(req.session)
      if (!userId) {
        return res.status(401).json({ error: 'unauthorized' })
      }

      const pending = req.session[PENDING_EMAIL_SESSION_KEY]
      if (!pending || pending.userId !== userId) {
        return res.status(422).json(messageBody('error_performing_request'))
      }

      // Only replaces the entry once the new code has been sent. Resetting
      // attempts and expiry is what allows another round of entries.
      Object.assign(pending, await issueConfirmationCode(pending.email))

      return res.status(200).json(messageBody('we_sent_new_code'))
    } catch (err) {
      logger.error(
        { err, sessionUserId: SessionManager.getLoggedInUserId(req.session) },
        'Failed to resend self-service secondary email confirmation code'
      )
      return res.status(500).json(messageBody('error_performing_request'))
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
