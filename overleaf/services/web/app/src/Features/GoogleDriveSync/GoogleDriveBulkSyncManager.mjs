import OError from '@overleaf/o-error'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import ProjectGetter from '../Project/ProjectGetter.mjs'

/**
 * Persistence for "sync selected projects to Google Drive" jobs.
 *
 * A job is a user's chosen list of projects, stored in Mongo so the work
 * belongs to the server rather than the browser tab that asked for it:
 * closing the page, navigating away or restarting web all leave the job in
 * place for GoogleDriveBulkSyncWorker to pick up.
 *
 * `active: true` is set only while a job is queued or running. The partial
 * unique index on `userId` over that flag is what guarantees a user never has
 * two bulk syncs racing each other over the same Drive folder.
 */

const MAX_PROJECTS_PER_JOB = 1000

const ACTIVE_STATUSES = ['queued', 'running']

class BulkSyncAlreadyRunningError extends OError {}
class InvalidBulkSyncRequestError extends OError {}

function _toObjectId(id) {
  if (!id) return null
  if (typeof id === 'object' && id._bsontype === 'ObjectID') return id
  if (typeof id === 'string' && ObjectId.isValid(id)) {
    return new ObjectId(id)
  }
  return id
}

/**
 * Projects the user owns and hasn't trashed.
 *
 * Collaborator projects are left out on purpose: googleDriveProjectStates
 * holds one Drive folder per project, so letting a collaborator sync would
 * re-point the owner's project at the collaborator's Drive.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<Array<object>>}
 */
async function _getSyncableProjects(userId) {
  const { owned } = await ProjectGetter.promises.findAllUsersProjects(userId, {
    _id: 1,
    name: 1,
    lastUpdated: 1,
    trashed: 1,
  })
  const userIdStr = userId.toString()
  return (owned || []).filter(
    project => !(project.trashed || []).some(id => id.toString() === userIdStr)
  )
}

/**
 * Serialises a job document for the browser.
 *
 * @param {object|null} job
 * @returns {object|null}
 */
function serializeJob(job) {
  if (!job) {
    return null
  }
  const projects = job.projects || []
  const count = status => projects.filter(p => p.status === status).length
  return {
    id: job._id.toString(),
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null,
    total: projects.length,
    syncedCount: count('synced'),
    failedCount: count('failed'),
    projects: projects.map(p => ({
      projectId: p.projectId.toString(),
      name: p.name,
      status: p.status,
      error: p.error || null,
    })),
  }
}

/**
 * Lists the projects a user can pick from, with their current Drive state.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<Array<{ id: string, name: string, lastUpdated: Date, linked: boolean, lastSyncedAt: Date|null }>>}
 */
async function listSyncableProjects(userId) {
  const projects = await _getSyncableProjects(userId)
  const states = await db.googleDriveProjectStates
    .find(
      { projectId: { $in: projects.map(p => p._id) } },
      { projection: { projectId: 1, driveFolderId: 1, lastSyncedAt: 1 } }
    )
    .toArray()
  const stateById = new Map(states.map(s => [s.projectId.toString(), s]))

  return projects
    .map(project => {
      const state = stateById.get(project._id.toString())
      return {
        id: project._id.toString(),
        name: project.name,
        lastUpdated: project.lastUpdated || null,
        linked: Boolean(state?.driveFolderId),
        lastSyncedAt: state?.lastSyncedAt || null,
      }
    })
    .sort(
      (a, b) =>
        new Date(b.lastUpdated || 0).getTime() -
        new Date(a.lastUpdated || 0).getTime()
    )
}

/**
 * Queues a bulk sync of the given projects.
 *
 * @param {string|ObjectId} userId
 * @param {Array<string>} projectIds
 * @returns {Promise<object>} the inserted job document
 */
async function createJob(userId, projectIds) {
  if (!Array.isArray(projectIds) || projectIds.length === 0) {
    throw new InvalidBulkSyncRequestError('No projects selected')
  }
  const requested = [...new Set(projectIds.map(id => String(id)))]
  if (requested.length > MAX_PROJECTS_PER_JOB) {
    throw new InvalidBulkSyncRequestError(
      `Cannot sync more than ${MAX_PROJECTS_PER_JOB} projects at once`
    )
  }

  const syncable = await _getSyncableProjects(userId)
  const syncableById = new Map(syncable.map(p => [p._id.toString(), p]))
  const unknown = requested.filter(id => !syncableById.has(id))
  if (unknown.length > 0) {
    throw new InvalidBulkSyncRequestError(
      'Some selected projects cannot be synced',
      { projectIds: unknown }
    )
  }

  const now = new Date()
  const job = {
    userId: _toObjectId(userId),
    status: 'queued',
    active: true,
    projects: requested.map(id => ({
      projectId: syncableById.get(id)._id,
      name: syncableById.get(id).name,
      status: 'queued',
    })),
    createdAt: now,
    updatedAt: now,
  }

  try {
    const { insertedId } = await db.googleDriveBulkSyncJobs.insertOne(job)
    return { ...job, _id: insertedId }
  } catch (err) {
    if (err?.code === 11000) {
      throw new BulkSyncAlreadyRunningError(
        'A Google Drive sync is already running'
      )
    }
    throw err
  }
}

/**
 * The user's unfinished job if there is one, otherwise their most recent.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<object|null>}
 */
async function getLatestJob(userId) {
  const userObjectId = _toObjectId(userId)
  const active = await db.googleDriveBulkSyncJobs.findOne({
    userId: userObjectId,
    active: true,
  })
  if (active) {
    return active
  }
  return await db.googleDriveBulkSyncJobs.findOne(
    { userId: userObjectId },
    { sort: { createdAt: -1 } }
  )
}

/**
 * Cancels every unfinished job for the user.
 *
 * A project already mid-sync finishes, since syncProject can't be interrupted
 * safely; the worker checks for cancellation before starting the next one.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<void>}
 */
async function cancelActiveJobs(userId) {
  const now = new Date()
  await db.googleDriveBulkSyncJobs.updateMany(
    { userId: _toObjectId(userId), active: true },
    {
      $set: { status: 'cancelled', finishedAt: now, updatedAt: now },
      $unset: { active: '', leaseExpiresAt: '' },
    }
  )
}

const GoogleDriveBulkSyncManager = {
  ACTIVE_STATUSES,
  MAX_PROJECTS_PER_JOB,
  BulkSyncAlreadyRunningError,
  InvalidBulkSyncRequestError,
  serializeJob,
  listSyncableProjects,
  createJob,
  getLatestJob,
  cancelActiveJobs,
}

export default GoogleDriveBulkSyncManager
export {
  ACTIVE_STATUSES,
  MAX_PROJECTS_PER_JOB,
  BulkSyncAlreadyRunningError,
  InvalidBulkSyncRequestError,
  serializeJob,
  listSyncableProjects,
  createJob,
  getLatestJob,
  cancelActiveJobs,
}
