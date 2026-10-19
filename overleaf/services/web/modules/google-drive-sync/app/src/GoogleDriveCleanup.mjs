import logger from '@overleaf/logger'
import { db, ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'
import GoogleDriveOAuthManager from './GoogleDriveOAuthManager.mjs'

/**
 * Removes Drive data once the user or project it belongs to is gone. Without
 * this, the polling and channel-renewal workers keep using a deleted user's
 * tokens, and the outbound worker keeps retrying expired projects.
 */

function _toObjectId(id) {
  if (typeof id === 'string' && ObjectId.isValid(id)) {
    return new ObjectId(id)
  }
  return id
}

/**
 * Fired on account deletion and again on expiry; the second run finds nothing.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<void>}
 */
async function onUserDeleted(userId) {
  const userObjectId = _toObjectId(userId)

  // Unlinking revokes the grant at Google and stops the push channel. A
  // failure there must not keep the tokens stored, so they go regardless.
  try {
    await GoogleDriveOAuthManager.unlinkAccount(userObjectId)
  } catch (err) {
    logger.warn(
      { err, userId },
      'GoogleDriveSync: unlink failed while deleting user, removing credentials'
    )
    await db.googleDriveUserCredentials.deleteOne({ user_id: userObjectId })
  }

  await db.googleDriveProjectStates.deleteMany({ userId: userObjectId })
  await db.googleDriveBulkSyncJobs.deleteMany({ userId: userObjectId })
  await db.googleDriveImportJobs.deleteMany({ userId: userObjectId })
}

/**
 * Fired when a deleted project is purged for good.
 *
 * @param {string|ObjectId} projectId
 * @returns {Promise<void>}
 */
async function onProjectExpired(projectId) {
  await db.googleDriveProjectStates.deleteOne({
    projectId: _toObjectId(projectId),
  })
}

const GoogleDriveCleanup = { onUserDeleted, onProjectExpired }

export default GoogleDriveCleanup
