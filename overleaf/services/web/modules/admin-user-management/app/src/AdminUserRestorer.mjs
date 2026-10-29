import { db, ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'
import UserDeleter from '../../../../app/src/Features/User/UserDeleter.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import ProjectDeleter from '../../../../app/src/Features/Project/ProjectDeleter.mjs'
import UserAuditLogHandler from '../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import { DeletedUser } from '../../../../app/src/models/DeletedUser.mjs'
import { DeletedProject } from '../../../../app/src/models/DeletedProject.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import { UserAuditLogEntry } from '../../../../app/src/models/UserAuditLogEntry.mjs'
import { NotFoundError, ConflictError } from './AdminUserGuards.mjs'

async function restoreArchivedProject(deletedProject, ownerId) {
  const projectId = deletedProject.deleterData.deletedProjectId
  const activeProject = await db.projects.findOne({
    _id: new ObjectId(projectId),
  })
  if (!activeProject) {
    await ProjectDeleter.promises.undeleteProject(projectId)
    return
  }

  // Native undelete performs name generation, unarchiving and deleted-doc
  // backfill before insertion. Only archive removal remains after insertion.
  // Reconcile that final step without replaying the insert or those side effects.
  const archivedProject = deletedProject.project
  const isArchived =
    activeProject.archived &&
    (!Array.isArray(activeProject.archived) ||
      activeProject.archived.length > 0)
  const hasDeletedDocs =
    activeProject.deletedDocs &&
    (!Array.isArray(activeProject.deletedDocs) ||
      activeProject.deletedDocs.length > 0)
  if (
    !archivedProject ||
    String(archivedProject._id) !== String(projectId) ||
    String(activeProject._id) !== String(projectId) ||
    String(archivedProject.owner_ref) !== String(ownerId) ||
    String(deletedProject.deleterData.deletedProjectOwnerId) !==
      String(ownerId) ||
    String(activeProject.owner_ref) !== String(ownerId) ||
    isArchived ||
    hasDeletedDocs
  ) {
    throw new ConflictError('active_project_conflicts_with_recovery_archive')
  }
  await DeletedProject.deleteOne({
    _id: deletedProject._id,
    'deleterData.deletedProjectId': projectId,
    'deleterData.deletedProjectOwnerId': ownerId,
    'deleterData.deletedReason': 'account-deletion',
    'project._id': archivedProject._id,
  }).exec()
}

export async function restoreUserAndProjects(userId, callerUserId, ipAddress) {
  const userObjectId = new ObjectId(userId)
  const deletedUser = await DeletedUser.findOne({
    'deleterData.deletedUserId': userObjectId,
  }).exec()

  if (!deletedUser || !deletedUser.user) {
    throw new NotFoundError('user_too_old_to_restore_or_not_found')
  }

  const activeUser = await db.users.findOne({ _id: userObjectId })

  // An active account is authoritative on retry; its archived addresses may
  // since have changed or been legitimately claimed by another account.
  if (!activeUser) {
    // Check if primary email is already in use by an active user
    const primaryEmailExists = await UserGetter.promises.getUserByAnyEmail(
      deletedUser.user.email
    )
    if (
      primaryEmailExists &&
      String(primaryEmailExists._id) !== String(userObjectId)
    ) {
      throw new ConflictError('email_already_in_use_by_active_user')
    }

    // Check secondary emails
    if (Array.isArray(deletedUser.user.emails)) {
      for (const emailEntry of deletedUser.user.emails) {
        if (emailEntry?.email) {
          const secondaryEmailExists =
            await UserGetter.promises.getUserByAnyEmail(emailEntry.email)
          if (
            secondaryEmailExists &&
            String(secondaryEmailExists._id) !== String(userObjectId)
          ) {
            throw new ConflictError('email_already_in_use_by_active_user')
          }
        }
      }
    }
  }

  // Recovery owns these archives now. A missing deletion date excludes them
  // from native age-based expiry while an administrator retries recovery.
  await db.deletedUsers.updateOne(
    { _id: deletedUser._id },
    { $unset: { 'deleterData.deletedAt': '' } }
  )
  await db.deletedProjects.updateMany(
    {
      'deleterData.deletedProjectOwnerId': userObjectId,
      'deleterData.deletedReason': 'account-deletion',
      project: { $type: 'object' },
    },
    { $unset: { 'deleterData.deletedAt': '' } }
  )

  // Re-insert user directly using native MongoDB driver to preserve _id and hashes
  const restoredUser = activeUser || new User(deletedUser.user)
  if (!activeUser) await db.users.insertOne(restoredUser)

  // Find all soft-deleted projects for this user
  const deletedProjects = await DeletedProject.find({
    'deleterData.deletedProjectOwnerId': userObjectId,
    'deleterData.deletedReason': 'account-deletion',
    project: { $type: 'object' },
  }).exec()

  let restoredProjectCount = 0
  const failedProjectIds = []
  for (const deletedProject of deletedProjects) {
    try {
      await restoreArchivedProject(deletedProject, userObjectId)
      restoredProjectCount++
    } catch (err) {
      failedProjectIds.push(String(deletedProject.deleterData.deletedProjectId))
    }
  }

  // Retain the archive until all projects are restored so a retry can resume.
  if (failedProjectIds.length === 0) {
    await DeletedUser.deleteOne({ _id: deletedUser._id }).exec()
  }

  await UserAuditLogHandler.promises.addEntry(
    userObjectId,
    'admin-restore-user',
    callerUserId,
    ipAddress || '0.0.0.0',
    { restoredProjectCount, failedProjectIds }
  )

  return {
    restoredUser,
    restoredProjectCount,
    failedProjectIds,
  }
}

export async function purgeDeletedUser(userId, callerUserId, ipAddress) {
  const userObjectId = new ObjectId(userId)
  const deletedUser = await DeletedUser.findOne({
    $or: [{ 'deleterData.deletedUserId': userObjectId }, { _id: userObjectId }],
  }).exec()

  if (!deletedUser) {
    throw new NotFoundError('deleted_user_not_found')
  }

  const actualDeletedUserId =
    deletedUser.deleterData?.deletedUserId || deletedUser._id

  // A retained archive may belong to a partially restored, active account.
  if (await db.users.findOne({ _id: actualDeletedUserId })) {
    throw new ConflictError('cannot_purge_restored_user')
  }

  const projects = await DeletedProject.find({
    'deleterData.deletedProjectOwnerId': actualDeletedUserId,
  }).exec()
  for (const project of projects) {
    await ProjectDeleter.promises.expireDeletedProject(
      project.deleterData.deletedProjectId
    )
  }
  // Native expiry cleans backing stores/hooks before tombstones are removed.
  await UserDeleter.promises.expireDeletedUser(actualDeletedUserId)
  await UserAuditLogEntry.deleteMany({ userId: actualDeletedUserId }).exec()

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
