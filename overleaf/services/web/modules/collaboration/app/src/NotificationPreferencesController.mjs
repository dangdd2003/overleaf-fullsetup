import { expressify } from '@overleaf/promise-utils'
import { db } from '../../../../app/src/infrastructure/mongodb.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

export const DEFAULT_PROJECT_PREFERENCES = {
  trackedChangesOnOwnProject: true,
  trackedChangesOnInvitedProject: false,
  commentOnOwnProject: true,
  commentOnInvitedProject: false,
  repliesOnAuthoredThread: true,
  repliesOnParticipatingThread: true,
  muteAllNotifications: false,
  commentResolvedOnAuthoredThread: true,
  commentResolvedOnParticipatingThread: true,
  commentReopenedOnAuthoredThread: true,
  commentReopenedOnParticipatingThread: true,
  trackChangesAcceptedOnAuthoredChange: true,
  trackChangesRejectedOnAuthoredChange: true,
}

export async function getUserProjectPreferences(userId, projectId) {
  const record = await db.notificationsPreferences.findOne({
    user_id: userId.toString(),
    project_id: projectId.toString(),
  })
  if (!record || !record.preferences) {
    return { ...DEFAULT_PROJECT_PREFERENCES }
  }
  return {
    ...DEFAULT_PROJECT_PREFERENCES,
    ...record.preferences,
  }
}

async function getPreferences(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    throw new Error('no logged-in user')
  }
  const { project_id: projectId } = req.params

  const preferences = await getUserProjectPreferences(userId, projectId)
  res.json(preferences)
}

async function updatePreferences(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    throw new Error('no logged-in user')
  }
  const { project_id: projectId } = req.params
  // Only the known boolean switches are stored; anything else in the body is dropped
  const preferences = Object.fromEntries(
    Object.entries(req.body || {}).filter(
      ([key, value]) =>
        Object.hasOwn(DEFAULT_PROJECT_PREFERENCES, key) &&
        typeof value === 'boolean'
    )
  )

  await db.notificationsPreferences.updateOne(
    {
      user_id: userId.toString(),
      project_id: projectId.toString(),
    },
    {
      $set: {
        user_id: userId.toString(),
        project_id: projectId.toString(),
        preferences,
        updated_at: new Date(),
      },
    },
    { upsert: true }
  )

  res.sendStatus(200)
}

export default {
  getPreferences: expressify(getPreferences),
  updatePreferences: expressify(updatePreferences),
  getUserProjectPreferences,
  DEFAULT_PROJECT_PREFERENCES,
}
