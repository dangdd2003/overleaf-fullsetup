import OError from '@overleaf/o-error'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import GoogleDriveClient from './GoogleDriveClient.mjs'

/**
 * Persistence and domain logic for "scan and import existing folders from Google Drive" jobs.
 *
 * Jobs run asynchronously in GoogleDriveImportWorker.
 * The active: true partial unique index guarantees a user never runs multiple concurrent import jobs.
 */

const MAX_FOLDERS_PER_JOB = 100

class ImportJobAlreadyRunningError extends OError {}
class InvalidImportRequestError extends OError {}

function _toObjectId(id) {
  if (!id) return null
  if (typeof id === 'object' && id._bsontype === 'ObjectID') return id
  if (typeof id === 'string' && ObjectId.isValid(id)) {
    return new ObjectId(id)
  }
  return id
}

/**
 * Fast-lists direct folder children under the user's Overleaf Google Drive root folder.
 * Only queries folder names and IDs without traversing subdirectories or file contents.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<Array<object>>}
 */
async function listImportableFolders(userId) {
  const userObjectId = _toObjectId(userId)
  const rootFolderId = await GoogleDriveClient.getOrCreateRootFolder(userId)

  const projectStates = await db.googleDriveProjectStates
    .find({ userId: userObjectId })
    .toArray()

  const projectByFolderId = new Map()
  const projectByFolderName = new Map()
  for (const st of projectStates) {
    if (st.driveFolderId) {
      projectByFolderId.set(st.driveFolderId, st)
    }
    if (st.folderName) {
      projectByFolderName.set(st.folderName, st)
    }
  }

  const query = `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  const fields = 'files(id,name,modifiedTime),nextPageToken'

  const folders = []
  let pageToken = null

  do {
    const res = await GoogleDriveClient.listFiles(
      userId,
      query,
      fields,
      pageToken
    )
    const files = res?.files || []

    for (const file of files) {
      const existing =
        projectByFolderId.get(file.id) || projectByFolderName.get(file.name)

      folders.push({
        folderId: file.id,
        name: file.name,
        linked: Boolean(existing),
        projectId: existing?.projectId ? existing.projectId.toString() : null,
        lastSyncedAt: existing?.lastSyncedAt || null,
      })
    }

    pageToken = res?.nextPageToken || null
  } while (pageToken)

  // Sort alphabetically by folder name
  folders.sort((a, b) => a.name.localeCompare(b.name))
  return folders
}

/**
 * Creates a new background import job for the requested Google Drive folders.
 *
 * @param {string|ObjectId} userId
 * @param {string[]} folderIds
 * @returns {Promise<object>} Created job document
 */
async function createImportJob(userId, folderIds) {
  if (!Array.isArray(folderIds) || folderIds.length === 0) {
    throw new InvalidImportRequestError('No folders selected')
  }

  if (folderIds.length > MAX_FOLDERS_PER_JOB) {
    throw new InvalidImportRequestError(
      `Cannot import more than ${MAX_FOLDERS_PER_JOB} folders at once`
    )
  }

  const requested = [...new Set(folderIds.map(id => String(id)))]
  const userObjectId = _toObjectId(userId)

  // Fast verify requested folders exist in user's Drive
  const availableFolders = await listImportableFolders(userId)
  const folderById = new Map(availableFolders.map(f => [f.folderId, f]))

  const selectedFolders = []
  for (const id of requested) {
    const f = folderById.get(id)
    if (!f) {
      throw new InvalidImportRequestError(
        `Selected folder does not exist in Google Drive: ${id}`
      )
    }
    selectedFolders.push({
      folderId: f.folderId,
      name: f.name,
      status: 'queued',
      projectId: f.projectId ? _toObjectId(f.projectId) : null,
    })
  }

  const now = new Date()
  const job = {
    userId: userObjectId,
    status: 'queued',
    active: true,
    folders: selectedFolders,
    createdAt: now,
    updatedAt: now,
  }

  try {
    const { insertedId } = await db.googleDriveImportJobs.insertOne(job)
    return { ...job, _id: insertedId }
  } catch (err) {
    if (err?.code === 11000) {
      throw new ImportJobAlreadyRunningError(
        'A Google Drive import is already in progress'
      )
    }
    throw err
  }
}

/**
 * Retrieves the currently active import job, or falls back to the most recent one.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<object|null>}
 */
async function getLatestJob(userId) {
  const userObjectId = _toObjectId(userId)
  const activeJob = await db.googleDriveImportJobs.findOne({
    userId: userObjectId,
    active: true,
  })
  if (activeJob) return activeJob

  return db.googleDriveImportJobs.findOne(
    { userId: userObjectId },
    { sort: { createdAt: -1 } }
  )
}

/**
 * Cancels any active import job for the user.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<void>}
 */
async function cancelActiveJobs(userId) {
  const userObjectId = _toObjectId(userId)
  const now = new Date()
  await db.googleDriveImportJobs.updateMany(
    { userId: userObjectId, active: true },
    {
      $set: { status: 'cancelled', finishedAt: now, updatedAt: now },
      $unset: { active: '', leaseExpiresAt: '' },
    }
  )
}

/**
 * Serializes an import job document for API consumption.
 *
 * @param {object|null} job
 * @returns {object|null}
 */
function serializeJob(job) {
  if (!job) return null

  const folders = (job.folders || []).map(f => ({
    folderId: f.folderId,
    name: f.name,
    status: f.status,
    projectId: f.projectId ? f.projectId.toString() : null,
    error: f.error || null,
  }))

  const importedCount = folders.filter(f => f.status === 'synced').length
  const failedCount = folders.filter(f => f.status === 'failed').length

  return {
    id: job._id?.toString?.() || String(job._id),
    status: job.status,
    total: folders.length,
    importedCount,
    failedCount,
    folders,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
  }
}

const GoogleDriveImportManager = {
  ImportJobAlreadyRunningError,
  InvalidImportRequestError,
  listImportableFolders,
  createImportJob,
  getLatestJob,
  cancelActiveJobs,
  serializeJob,
}

export default GoogleDriveImportManager
export {
  ImportJobAlreadyRunningError,
  InvalidImportRequestError,
  listImportableFolders,
  createImportJob,
  getLatestJob,
  cancelActiveJobs,
  serializeJob,
}
