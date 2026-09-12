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
