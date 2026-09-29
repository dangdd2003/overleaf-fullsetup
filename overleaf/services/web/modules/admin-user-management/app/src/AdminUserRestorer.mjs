import { db, ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import ProjectDeleter from '../../../../app/src/Features/Project/ProjectDeleter.mjs'
import UserAuditLogHandler from '../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { DeletedUser } from '../../../../app/src/models/DeletedUser.mjs'
import { DeletedProject } from '../../../../app/src/models/DeletedProject.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import {
  NotFoundError,
  ConflictError,
} from './AdminUserGuards.mjs'

export async function restoreUserAndProjects(userId, callerUserId, ipAddress) {
  const userObjectId = new ObjectId(userId)
  const deletedUser = await DeletedUser.findOne({
    'deleterData.deletedUserId': userObjectId,
  }).exec()

  if (!deletedUser || !deletedUser.user) {
    throw new NotFoundError('user_too_old_to_restore_or_not_found')
  }

  // Check if primary email is already in use by an active user
  const primaryEmailExists = await UserGetter.promises.getUserByAnyEmail(
    deletedUser.user.email
  )
  if (primaryEmailExists) {
    throw new ConflictError('email_already_in_use_by_active_user')
  }

  // Check secondary emails
  if (Array.isArray(deletedUser.user.emails)) {
    for (const emailEntry of deletedUser.user.emails) {
      if (emailEntry?.email) {
        const secondaryEmailExists = await UserGetter.promises.getUserByAnyEmail(
          emailEntry.email
        )
        if (secondaryEmailExists) {
          throw new ConflictError('email_already_in_use_by_active_user')
        }
      }
    }
  }

  // Re-insert user directly using native MongoDB driver to preserve _id and hashes
  const restoredUser = new User(deletedUser.user)
  await db.users.insertOne(restoredUser)
  await DeletedUser.deleteOne({ _id: deletedUser._id }).exec()

  // Find all soft-deleted projects for this user
  const deletedProjects = await DeletedProject.find({
    'deleterData.deletedProjectOwnerId': userObjectId,
    'deleterData.deletedReason': 'account-deletion',
    project: { $type: 'object' },
  }).exec()

  let restoredProjectCount = 0
  for (const deletedProject of deletedProjects) {
    try {
      await ProjectDeleter.promises.undeleteProject(
        deletedProject.deleterData.deletedProjectId
      )
      restoredProjectCount++
    } catch (err) {
      // Continue restoring other projects if one encounters an error
    }
  }

  await UserAuditLogHandler.promises.addEntry(
    userObjectId,
    'admin-restore-user',
    callerUserId,
    ipAddress || '0.0.0.0',
    { restoredProjectCount }
  )

  return {
    restoredUser,
    restoredProjectCount,
  }
}

export async function purgeDeletedUser(userId, callerUserId, ipAddress) {
  const userObjectId = new ObjectId(userId)
  const deletedUser = await DeletedUser.findOne({
    $or: [
      { 'deleterData.deletedUserId': userObjectId },
      { _id: userObjectId },
    ],
  }).exec()

  if (!deletedUser) {
    throw new NotFoundError('deleted_user_not_found')
  }

  const actualDeletedUserId =
    deletedUser.deleterData?.deletedUserId || deletedUser._id

  // Remove archived projects associated with this deleted user
  await DeletedProject.deleteMany({
    'deleterData.deletedProjectOwnerId': actualDeletedUserId,
  }).exec()

  // Remove the deleted user record completely
  await DeletedUser.deleteOne({ _id: deletedUser._id }).exec()

  return {
    success: true,
    purgedUserId: actualDeletedUserId.toString(),
  }
}

