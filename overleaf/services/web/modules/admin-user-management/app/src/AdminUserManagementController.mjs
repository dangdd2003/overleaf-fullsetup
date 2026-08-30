import Path from 'node:path'
import { fileURLToPath } from 'node:url'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import UserSessionsManager from '../../../../app/src/Features/User/UserSessionsManager.mjs'
import UserDeleter from '../../../../app/src/Features/User/UserDeleter.mjs'
import UserAuditLogHandler from '../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import OneTimeTokenHandler from '../../../../app/src/Features/Security/OneTimeTokenHandler.mjs'
import { db, ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'
import {
  getActiveUsers,
  getDeletedUsers,
  getUserById,
  escapeRegExp,
} from './AdminUserQuery.mjs'
import { Project } from '../../../../app/src/models/Project.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import {
  ensureCanModifyAdmin,
  ensureCanDeleteUser,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from './AdminUserGuards.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../app/src/Features/User/UserUpdater.mjs'
import EmailHelper from '../../../../app/src/Features/Helpers/EmailHelper.mjs'
import OwnershipTransferHandler from '../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs'
import { restoreUserAndProjects, purgeDeletedUser } from './AdminUserRestorer.mjs'
import { UserAuditLogEntry } from '../../../../app/src/models/UserAuditLogEntry.mjs'
import UserCreator from '../../../../app/src/Features/User/UserCreator.mjs'
import AuthenticationManager from '../../../../app/src/Features/Authentication/AuthenticationManager.mjs'

const __dirname = Path.dirname(fileURLToPath(import.meta.url))

export const AdminUserManagementController = {
  renderUserListPage(req, res) {
    res.render(Path.resolve(__dirname, '../views/user_list'))
  },

  async renderUserDetailPage(req, res) {
    const { userId } = req.params
    if (!ObjectId.isValid(userId)) {
      return res.status(404).render('general/404')
    }

    const targetUser = await getUserById(userId)
    if (!targetUser) {
      return res.status(404).render('general/404')
    }

    res.render(Path.resolve(__dirname, '../views/user_detail'), {
      targetUserId: userId,
    })
  },

  async getActiveUsers(req, res) {
    try {
      const { search, page, limit, sortBy, sortOrder } = req.query
      const result = await getActiveUsers({
        search,
        page,
        limit,
        sortBy,
        sortOrder,
      })
      res.json(result)
    } catch (err) {
      logger.error({ err, query: req.query }, 'Failed to fetch active users')
      res.status(500).json({ error: 'failed_to_fetch_users' })
    }
  },

  async getDeletedUsers(req, res) {
    try {
      const { search, page, limit } = req.query
      const result = await getDeletedUsers({
        search,
        page,
        limit,
      })
      res.json(result)
    } catch (err) {
      logger.error({ err, query: req.query }, 'Failed to fetch deleted users')
      res.status(500).json({ error: 'failed_to_fetch_deleted_users' })
    }
  },

  async getUser(req, res) {
    try {
      const { userId } = req.params
      const user = await getUserById(userId)
      if (!user) {
        return res.status(404).json({ error: 'user_not_found' })
      }
      const hardDeletionDelayMs =
        Settings.userHardDeletionDelay || 90 * 24 * 60 * 60 * 1000
      const retentionDays = Math.round(
        hardDeletionDelayMs / (1000 * 60 * 60 * 24)
      )
      res.json({ user, config: { retentionDays } })
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'Failed to fetch user')
      res.status(500).json({ error: 'failed_to_fetch_user' })
    }
  },

  async updateUserProfile(req, res) {
    try {
      const { userId } = req.params
      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const { first_name, last_name } = req.body
      const firstNameSafe = typeof first_name === 'string' ? first_name.trim().slice(0, 100) : ''
      const lastNameSafe = typeof last_name === 'string' ? last_name.trim().slice(0, 100) : ''

      await db.users.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { first_name: firstNameSafe, last_name: lastNameSafe } }
      )

      await UserAuditLogHandler.promises.addEntry(
        new ObjectId(userId),
        'admin-update-user',
        callerUserId,
        req.ip || '0.0.0.0',
        { first_name: firstNameSafe, last_name: lastNameSafe }
      )

      const updatedUser = await getUserById(userId)
      res.json({ success: true, user: updatedUser })
    } catch (err) {
      logger.error({ err, body: req.body }, 'Failed to update user profile')
      res.status(500).json({ error: 'failed_to_update_profile' })
    }
  },

  async updateAdminStatus(req, res) {
    try {
      const { userId } = req.params
      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      if (req.body?.isAdmin === undefined) {
        return res.status(400).json({ error: 'invalid_admin_status' })
      }

      const { isAdmin } = req.body
      const newIsAdmin = Boolean(isAdmin)

      await ensureCanModifyAdmin(callerUserId, userId, newIsAdmin)

      await db.users.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { isAdmin: newIsAdmin } }
      )

      if (!newIsAdmin) {
        await UserSessionsManager.promises.removeSessionsFromRedis({
          _id: new ObjectId(userId),
        })
      }

      await UserAuditLogHandler.promises.addEntry(
        new ObjectId(userId),
        'admin-set-admin-status',
        callerUserId,
        req.ip || '0.0.0.0',
        { isAdmin: newIsAdmin }
      )

      res.json({ success: true, isAdmin: newIsAdmin })
    } catch (err) {
      if (err instanceof BadRequestError) {
        return res.status(400).json({ error: err.message })
      }
      if (err instanceof ForbiddenError) {
        return res.status(403).json({ error: err.message })
      }
      logger.error({ err, userId: req.params.userId }, 'Failed to update admin status')
      res.status(500).json({ error: 'failed_to_update_admin_status' })
    }
  },

  async generatePasswordResetLink(req, res) {
    try {
      const { userId } = req.params
      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      const user = await getUserById(userId)
      if (!user) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      const ONE_WEEK_IN_SECONDS = 7 * 24 * 60 * 60
      const token = await OneTimeTokenHandler.promises.getNewToken(
        'password',
        { user_id: user._id.toString(), email: user.email },
        { expiresIn: ONE_WEEK_IN_SECONDS }
      )

      const resetUrl = `${Settings.siteUrl}/user/password/set?passwordResetToken=${token}&email=${encodeURIComponent(user.email)}`
      const expiresAt = new Date(Date.now() + ONE_WEEK_IN_SECONDS * 1000).toISOString()

      await UserAuditLogHandler.promises.addEntry(
        new ObjectId(userId),
        'admin-generate-password-reset',
        callerUserId,
        req.ip || '0.0.0.0',
        {}
      )

      res.json({ resetUrl, expiresAt })
    } catch (err) {
      logger.error({ err, userId: req.params.userId }, 'Failed to generate reset link')
      res.status(500).json({ error: 'failed_to_generate_reset_link' })
    }
  },

  async deleteUser(req, res) {
    try {
      const { userId } = req.params
      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      const targetUser = await getUserById(userId)
      if (!targetUser) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      await ensureCanDeleteUser(callerUserId, targetUser)

      await UserDeleter.promises.deleteUser(new ObjectId(userId), {
        ipAddress: req.ip || '0.0.0.0',
        deleterUser: { _id: callerUserId },
        skipEmail: true,
      })

      res.json({ success: true })
    } catch (err) {
      if (err instanceof BadRequestError) {
        return res.status(400).json({ error: err.message })
      }
      if (err instanceof ForbiddenError) {
        return res.status(403).json({ error: err.message })
      }
      logger.error({ err, userId: req.params.userId }, 'Failed to delete user')
      res.status(500).json({ error: 'failed_to_delete_user' })
    }
  },

  async restoreUser(req, res) {
    try {
      const { userId } = req.params
      const callerUserId = SessionManager.getLoggedInUserId(req.session)

      const result = await restoreUserAndProjects(
        userId,
        callerUserId,
        req.ip || '0.0.0.0'
      )

      res.json({
        success: true,
        restoredProjectCount: result.restoredProjectCount,
      })
    } catch (err) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ error: err.message })
      }
      if (err instanceof ConflictError) {
        return res.status(409).json({ error: err.message })
      }
      logger.error({ err, userId: req.params.userId }, 'Failed to restore user')
      res.status(500).json({ error: 'failed_to_restore_user' })
    }
  },

  async purgeDeletedUser(req, res) {
    try {
      const { userId } = req.params
      const callerUserId = SessionManager.getLoggedInUserId(req.session)

      const result = await purgeDeletedUser(
        userId,
        callerUserId,
        req.ip || '0.0.0.0'
      )

      res.json(result)
    } catch (err) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ error: err.message })
      }
      logger.error({ err, userId: req.params.userId }, 'Failed to purge deleted user')
      res.status(500).json({ error: 'failed_to_purge_deleted_user' })
    }
  },

  async getUserSessions(req, res) {
    try {
      const { userId } = req.params
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const sessionsManager =
        UserSessionsManager.promises || UserSessionsManager
      const sessions =
        (await sessionsManager.getAllUserSessions({ _id: userId })) || []

      res.json({
        sessions,
        count: sessions.length,
      })
    } catch (err) {
      logger.error(
        { err, userId: req.params.userId },
        'Failed to fetch user sessions'
      )
      res.status(500).json({ error: 'failed_to_fetch_sessions' })
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

      const sessionsManager =
        UserSessionsManager.promises || UserSessionsManager
      const revokedCount =
        (await sessionsManager.removeSessionsFromRedis(
          { _id: userId },
          retainSessionID
        )) ?? 0

      await UserAuditLogHandler.promises.addEntry(
        new ObjectId(userId),
        'admin-revoke-sessions',
        callerUserId,
        req.ip || '0.0.0.0',
        {
          retainedSelf: Boolean(retainSessionID),
          revokedCount,
        }
      )

      res.json({
        success: true,
        revokedCount,
      })
    } catch (err) {
      logger.error(
        { err, userId: req.params.userId },
        'Failed to revoke user sessions'
      )
      res.status(500).json({ error: 'failed_to_revoke_sessions' })
    }
  },

  async addEmail(req, res) {
    try {
      const { userId } = req.params
      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const { email } = req.body || {}
      const parsedEmail = EmailHelper.parseEmail(email)
      if (!parsedEmail) {
        return res.status(400).json({ error: 'invalid_email' })
      }

      const targetUser = await getUserById(userId)
      if (!targetUser) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      const existingUser = await (
        UserGetter.promises?.getUserByAnyEmail || UserGetter.getUserByAnyEmail
      )(parsedEmail)
      if (existingUser) {
        return res.status(409).json({ error: 'email_already_registered' })
      }

      const userUpdater = UserUpdater.promises || UserUpdater
      await userUpdater.addEmailAddress(
        userId,
        parsedEmail,
        { confirmed: true },
        { initiatorId: callerUserId, ipAddress: req.ip || '0.0.0.0', info: {} }
      )
      const confirmFn = userUpdater.confirmEmail || UserUpdater.promises?.confirmEmail
      if (confirmFn) {
        await confirmFn(userId, parsedEmail)
      }

      await UserAuditLogHandler.promises.addEntry(
        new ObjectId(userId),
        'admin-added-email',
        callerUserId,
        req.ip || '0.0.0.0',
        { email: parsedEmail }
      )

      const updatedUser = await getUserById(userId)
      res.json({ success: true, user: updatedUser })
    } catch (err) {
      if (
        err.name === 'EmailExistsError' ||
        err.message?.includes('already registered') ||
        err.message?.includes('already exists')
      ) {
        return res.status(409).json({ error: 'email_already_registered' })
      }
      logger.error(
        { err, userId: req.params.userId, body: req.body },
        'Failed to add user email'
      )
      res.status(500).json({ error: 'failed_to_add_email' })
    }
  },

  async removeEmail(req, res) {
    try {
      const { userId } = req.params
      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const { email } = req.body || {}
      const parsedEmail = EmailHelper.parseEmail(email)
      if (!parsedEmail) {
        return res.status(400).json({ error: 'invalid_email' })
      }

      const targetUser = await getUserById(userId)
      if (!targetUser) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      if (targetUser.email === parsedEmail) {
        return res.status(400).json({ error: 'cannot_remove_primary_email' })
      }

      const userUpdater = UserUpdater.promises || UserUpdater
      await userUpdater.removeEmailAddress(
        userId,
        parsedEmail,
        { initiatorId: callerUserId, ipAddress: req.ip || '0.0.0.0', info: {} }
      )

      await UserAuditLogHandler.promises.addEntry(
        new ObjectId(userId),
        'admin-removed-email',
        callerUserId,
        req.ip || '0.0.0.0',
        { email: parsedEmail }
      )

      const updatedUser = await getUserById(userId)
      res.json({ success: true, user: updatedUser })
    } catch (err) {
      if (err.message === 'cannot remove primary email') {
        return res.status(400).json({ error: 'cannot_remove_primary_email' })
      }
      logger.error(
        { err, userId: req.params.userId, body: req.body },
        'Failed to remove user email'
      )
      res.status(500).json({ error: 'failed_to_remove_email' })
    }
  },

  async setPrimaryEmail(req, res) {
    try {
      const { userId } = req.params
      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const { email } = req.body || {}
      const parsedEmail = EmailHelper.parseEmail(email)
      if (!parsedEmail) {
        return res.status(400).json({ error: 'invalid_email' })
      }

      const targetUser = await getUserById(userId)
      if (!targetUser) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      const userUpdater = UserUpdater.promises || UserUpdater
      await userUpdater.setDefaultEmailAddress(
        userId,
        parsedEmail,
        true,
        { initiatorId: callerUserId, ipAddress: req.ip || '0.0.0.0', info: {} }
      )

      await UserAuditLogHandler.promises.addEntry(
        new ObjectId(userId),
        'admin-set-primary-email',
        callerUserId,
        req.ip || '0.0.0.0',
        { email: parsedEmail }
      )

      const updatedUser = await getUserById(userId)
      res.json({ success: true, user: updatedUser })
    } catch (err) {
      logger.error(
        { err, userId: req.params.userId, body: req.body },
        'Failed to set primary email'
      )
      res.status(500).json({ error: 'failed_to_set_primary_email' })
    }
  },

  async getUserProjects(req, res) {
    try {
      const { userId } = req.params
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1)
      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit, 10) || 10)
      )
      const search = (req.query.search || '').trim()
      const sort = req.query.sort === 'name' ? 'name' : 'lastUpdated'
      const order = req.query.order === 'asc' ? 1 : -1

      const matchQuery = {
        owner_ref: new ObjectId(userId),
        archived: { $ne: true },
      }
      if (search) {
        matchQuery.name = new RegExp(escapeRegExp(search), 'i')
      }

      const [projects, total] = await Promise.all([
        Project.find(matchQuery, {
          name: 1,
          lastUpdated: 1,
          collaberator_refs: 1,
          readOnly_refs: 1,
          publicAccesLevel: 1,
        })
          .sort({ [sort]: order })
          .skip((page - 1) * limit)
          .limit(limit),
        Project.countDocuments(matchQuery),
      ])

      const formattedProjects = (projects || []).map(p => ({
        _id: p._id.toString(),
        name: p.name || 'Untitled Project',
        lastUpdated: p.lastUpdated || null,
        collaboratorCount:
          (p.collaberator_refs?.length || 0) + (p.readOnly_refs?.length || 0),
        accessLevel: p.publicAccesLevel || 'private',
      }))

      return res.json({
        projects: formattedProjects,
        total,
        page,
        totalPages: Math.ceil(total / limit) || 1,
      })
    } catch (err) {
      logger.error(
        { err, userId: req.params.userId },
        'Failed to fetch user projects'
      )
      return res.status(500).json({ error: 'failed_to_get_projects' })
    }
  },

  async searchUsers(req, res) {
    try {
      const query = (req.query.query || '').trim()
      if (!query || query.length < 1) {
        return res.json({ users: [] })
      }

      const regex = new RegExp(escapeRegExp(query), 'i')
      const users = await User.find(
        {
          $or: [{ email: regex }, { first_name: regex }, { last_name: regex }],
          holdingAccount: { $ne: true },
        },
        {
          _id: 1,
          email: 1,
          first_name: 1,
          last_name: 1,
          isAdmin: 1,
        }
      ).limit(5)

      return res.json({ users: users || [] })
    } catch (err) {
      logger.error({ err, query: req.query.query }, 'Failed to search users')
      return res.status(500).json({ error: 'failed_to_search_users' })
    }
  },

  async transferProject(req, res) {
    try {
      const { userId, projectId } = req.params
      const { newOwnerId, toUserId } = req.body || {}
      const destinationUserId = newOwnerId || toUserId

      if (
        !ObjectId.isValid(userId) ||
        !ObjectId.isValid(projectId) ||
        !destinationUserId ||
        !ObjectId.isValid(destinationUserId)
      ) {
        return res.status(400).json({ error: 'invalid_id' })
      }

      if (String(userId) === String(destinationUserId)) {
        return res.status(400).json({ error: 'cannot_transfer_to_self' })
      }

      const destinationUser = await getUserById(destinationUserId)
      if (!destinationUser) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      const handler =
        OwnershipTransferHandler.promises || OwnershipTransferHandler
      await handler.transferOwnership(projectId, destinationUserId, {
        fromUserId: userId,
        allowTransferToNonCollaborators: true,
        ipAddress: req.ip,
      })

      return res.json({
        success: true,
        projectId,
        newOwnerId: destinationUserId,
      })
    } catch (err) {
      if (
        err.message === 'cannot_transfer_to_self' ||
        err.message?.includes('identical users')
      ) {
        return res.status(400).json({ error: 'cannot_transfer_to_self' })
      }
      if (
        err.name === 'UserNotFoundError' ||
        err.message?.includes('user not found') ||
        err.message?.includes('missing destination user') ||
        err.message?.includes('missing source user')
      ) {
        return res.status(404).json({ error: 'user_not_found' })
      }
      if (
        err.name === 'ProjectNotFoundError' ||
        err.message?.includes('project not found')
      ) {
        return res.status(404).json({ error: 'project_not_found' })
      }
      logger.error(
        {
          err,
          userId: req.params.userId,
          projectId: req.params.projectId,
          body: req.body,
        },
        'Failed to transfer project'
      )
      return res.status(500).json({ error: 'failed_to_transfer_project' })
    }
  },

  async transferAllProjects(req, res) {
    try {
      const { userId } = req.params
      const { toUserId, newOwnerId } = req.body || {}
      const destinationUserId = toUserId || newOwnerId

      if (
        !ObjectId.isValid(userId) ||
        !destinationUserId ||
        !ObjectId.isValid(destinationUserId)
      ) {
        return res.status(400).json({ error: 'invalid_id' })
      }

      if (String(userId) === String(destinationUserId)) {
        return res.status(400).json({ error: 'cannot_transfer_to_self' })
      }

      const destinationUser = await getUserById(destinationUserId)
      if (!destinationUser) {
        return res.status(404).json({ error: 'user_not_found' })
      }

      const handler =
        OwnershipTransferHandler.promises || OwnershipTransferHandler
      const result = await handler.transferAllProjectsToUser({
        fromUserId: userId,
        toUserId: destinationUserId,
        ipAddress: req.ip,
      })

      return res.json({
        success: true,
        transferredCount:
          result?.projectCount ?? result?.transferredCount ?? 0,
        newTagName: result?.newTagName,
      })
    } catch (err) {
      if (
        err.message === 'cannot_transfer_to_self' ||
        err.message?.includes('identical users')
      ) {
        return res.status(400).json({ error: 'cannot_transfer_to_self' })
      }
      if (
        err.name === 'UserNotFoundError' ||
        err.message?.includes('user not found') ||
        err.message?.includes('missing destination user') ||
        err.message?.includes('missing source user')
      ) {
        return res.status(404).json({ error: 'user_not_found' })
      }
      logger.error(
        { err, userId: req.params.userId, body: req.body },
        'Failed to transfer all projects'
      )
      return res.status(500).json({ error: 'failed_to_transfer_projects' })
    }
  },

  async getUserAuditLogs(req, res) {
    try {
      const { userId } = req.params
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ error: 'invalid_user_id' })
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1)
      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit, 10) || 10)
      )

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
      logger.error(
        { err, userId: req.params?.userId },
        'Failed to fetch user audit logs'
      )
      return res.status(500).json({ error: 'failed_to_get_audit_logs' })
    }
  },

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
        const rawEmail = row?.email
        const parsedEmail = EmailHelper.parseEmail(rawEmail)
        if (!parsedEmail) {
          failed.push({
            email: typeof rawEmail === 'string' ? rawEmail : '',
            reason: 'invalid_email',
          })
          continue
        }

        const userGetter = UserGetter.promises || UserGetter
        const existing = await (
          userGetter.getUserByAnyEmail || UserGetter.getUserByAnyEmail
        )(parsedEmail)
        if (existing) {
          skipped.push({ email: parsedEmail, reason: 'email_already_exists' })
          continue
        }

        const firstName =
          typeof row.first_name === 'string'
            ? row.first_name.trim().slice(0, 100)
            : ''
        const lastName =
          typeof row.last_name === 'string'
            ? row.last_name.trim().slice(0, 100)
            : ''
        const isAdmin = Boolean(row.isAdmin)
        const rawPassword =
          typeof row.password === 'string' ? row.password.trim() : ''

        const userCreator = UserCreator.promises || UserCreator
        const newUser = await userCreator.createNewUser(
          {
            email: parsedEmail,
            first_name: firstName,
            last_name: lastName,
            isAdmin,
            analyticsId: crypto.randomUUID(),
            holdingAccount: false,
          },
          {}
        )

        let passwordSet = false
        let setupUrl = null

        if (rawPassword.length > 0) {
          const hashFn =
            AuthenticationManager.promises?.hashPassword ||
            AuthenticationManager.hashPassword
          const hashedPassword = await hashFn(rawPassword)

          await User.updateOne(
            { _id: newUser._id },
            {
              $set: {
                hashedPassword,
                holdingAccount: false,
                loginCount: 0,
              },
            }
          )
          passwordSet = true
        } else {
          const tokenHandler =
            OneTimeTokenHandler.promises || OneTimeTokenHandler
          const ONE_WEEK_IN_SECONDS = 7 * 24 * 60 * 60
          const token = await (
            tokenHandler.getNewToken || OneTimeTokenHandler.getNewToken
          )('password', newUser._id, { expiresIn: ONE_WEEK_IN_SECONDS })
          const siteUrl = Settings.siteUrl || ''
          setupUrl = `${siteUrl}/user/password/set?token=${token}`
        }

        const auditLogHandler =
          UserAuditLogHandler.promises || UserAuditLogHandler
        await auditLogHandler.addEntry(
          newUser._id,
          'admin-register',
          callerUserId,
          req.ip || '0.0.0.0',
          { isAdmin, passwordSet }
        )

        created.push({
          _id: newUser._id ? newUser._id.toString() : '',
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
      logger.error({ err }, 'Failed to bulk create users')
      return res.status(500).json({ error: 'failed_to_bulk_create_users' })
    }
  },

  async batchDeleteUsers(req, res) {
    try {
      const { userIds } = req.body || {}
      if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: 'invalid_user_ids' })
      }

      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      let skippedSelf = false
      let deletedCount = 0
      const failed = []

      for (const rawId of userIds) {
        const userId = typeof rawId === 'string' ? rawId.trim() : ''
        if (!ObjectId.isValid(userId)) {
          failed.push({ userId: rawId, reason: 'invalid_user_id' })
          continue
        }

        if (callerUserId && callerUserId.toString() === userId) {
          skippedSelf = true
          continue
        }

        try {
          const targetUser = await getUserById(userId)
          if (!targetUser) {
            failed.push({ userId, reason: 'user_not_found' })
            continue
          }

          await ensureCanDeleteUser(callerUserId, targetUser)

          await UserDeleter.promises.deleteUser(new ObjectId(userId), {
            ipAddress: req.ip || '0.0.0.0',
            deleterUser: { _id: callerUserId },
            skipEmail: true,
          })

          deletedCount++
        } catch (err) {
          logger.error({ err, userId }, 'Failed to delete user in batch')
          failed.push({ userId, reason: err.message || 'failed_to_delete' })
        }
      }

      return res.json({
        success: true,
        deletedCount,
        skippedSelf,
        failed,
      })
    } catch (err) {
      logger.error({ err, body: req.body }, 'Failed to process batch delete')
      return res.status(500).json({ error: 'failed_to_batch_delete' })
    }
  },

  async batchRevokeUserSessions(req, res) {
    try {
      const { userIds } = req.body || {}
      if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: 'invalid_user_ids' })
      }

      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      let totalRevoked = 0
      const failed = []

      const userSessionsManager =
        UserSessionsManager.promises || UserSessionsManager
      const auditLogHandler =
        UserAuditLogHandler.promises || UserAuditLogHandler

      for (const rawId of userIds) {
        const userId = typeof rawId === 'string' ? rawId.trim() : ''
        if (!ObjectId.isValid(userId)) {
          failed.push({ userId: rawId, reason: 'invalid_user_id' })
          continue
        }

        const options = {}
        if (
          callerUserId &&
          callerUserId.toString() === userId &&
          req.sessionID
        ) {
          options.retainSessionID = req.sessionID
        }

        try {
          if (typeof userSessionsManager.removeSessionsFromRedis === 'function') {
            await userSessionsManager.removeSessionsFromRedis(
              { _id: new ObjectId(userId) },
              options
            )
          }

          await auditLogHandler.addEntry(
            new ObjectId(userId),
            'admin-revoked-sessions',
            callerUserId,
            req.ip || '0.0.0.0',
            {}
          )

          totalRevoked++
        } catch (err) {
          logger.error({ err, userId }, 'Failed to revoke user session in batch')
          failed.push({ userId, reason: err.message || 'failed_to_revoke' })
        }
      }

      return res.json({
        success: true,
        totalRevoked,
        failed,
      })
    } catch (err) {
      logger.error(
        { err, body: req.body },
        'Failed to process batch revoke sessions'
      )
      return res.status(500).json({ error: 'failed_to_batch_revoke_sessions' })
    }
  },

  async batchRestoreUsers(req, res) {
    try {
      const { userIds } = req.body || {}
      if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: 'invalid_user_ids' })
      }

      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      let restoredCount = 0
      let restoredProjectsCount = 0
      const failed = []

      for (const rawId of userIds) {
        const userId = typeof rawId === 'string' ? rawId.trim() : ''
        if (!ObjectId.isValid(userId)) {
          failed.push({ userId: rawId, reason: 'invalid_user_id' })
          continue
        }

        try {
          const result = await restoreUserAndProjects(
            userId,
            callerUserId,
            req.ip || '0.0.0.0'
          )
          restoredCount++
          restoredProjectsCount += result?.restoredProjectCount || 0
        } catch (err) {
          logger.error({ err, userId }, 'Failed to restore user in batch')
          failed.push({ userId, reason: err.message || 'failed_to_restore' })
        }
      }

      return res.json({
        success: true,
        restoredCount,
        restoredProjectsCount,
        failed,
      })
    } catch (err) {
      logger.error({ err, body: req.body }, 'Failed to process batch restore')
      return res.status(500).json({ error: 'failed_to_batch_restore' })
    }
  },

  async batchPurgeDeletedUsers(req, res) {
    try {
      const { recordIds } = req.body || {}
      if (!Array.isArray(recordIds) || recordIds.length === 0) {
        return res.status(400).json({ error: 'invalid_record_ids' })
      }

      const callerUserId = SessionManager.getLoggedInUserId(req.session)
      let purgedCount = 0
      const failed = []

      for (const rawId of recordIds) {
        const recordId = typeof rawId === 'string' ? rawId.trim() : ''
        if (!ObjectId.isValid(recordId)) {
          failed.push({ recordId: rawId, reason: 'invalid_record_id' })
          continue
        }

        try {
          await purgeDeletedUser(
            recordId,
            callerUserId,
            req.ip || '0.0.0.0'
          )
          purgedCount++
        } catch (err) {
          logger.error(
            { err, recordId },
            'Failed to purge deleted user in batch'
          )
          failed.push({ recordId, reason: err.message || 'failed_to_purge' })
        }
      }

      return res.json({
        success: true,
        purgedCount,
        failed,
      })
    } catch (err) {
      logger.error({ err, body: req.body }, 'Failed to process batch purge')
      return res.status(500).json({ error: 'failed_to_batch_purge' })
    }
  },
}

export default AdminUserManagementController
