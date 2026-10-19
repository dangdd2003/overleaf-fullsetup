import mongoose from '../../../../../app/src/infrastructure/Mongoose.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

export const GoogleDriveUserCredentialsSchema = new Schema(
  {
    user_id: { type: ObjectId, ref: 'User', required: true, unique: true },
    googleEmail: { type: String },
    googleUserId: { type: String },
    encryptedAccessToken: { type: String },
    encryptedRefreshToken: { type: String },
    tokenExpiry: { type: Date },
    linkedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    startPageToken: { type: String },
    watchChannelId: { type: String },
    watchResourceId: { type: String },
    watchChannelToken: { type: String },
    watchExpiresAt: { type: Date },
    consecutiveAuthErrors: { type: Number, default: 0 },
  },
  { collection: 'googleDriveUserCredentials', minimize: false }
)

GoogleDriveUserCredentialsSchema.index({ watchChannelId: 1 }, { sparse: true })

export const GoogleDriveProjectStatesSchema = new Schema(
  {
    projectId: { type: ObjectId, ref: 'Project' },
    userId: { type: ObjectId, ref: 'User', required: true },
    driveFolderId: { type: String },
    folderName: { type: String },
    fileMap: { type: Schema.Types.Mixed, default: () => ({}) },
    folderMap: { type: Schema.Types.Mixed, default: () => ({}) },
    pendingChanges: { type: Schema.Types.Mixed, default: () => ({}) },
    syncStatus: {
      type: String,
      enum: ['idle', 'syncing', 'error', 'pending'],
      default: 'idle',
    },
    isSyncing: { type: Boolean, default: false },
    lockExpiresAt: { type: Date },
    syncSuspended: { type: Boolean, default: false },
    suspendReason: { type: String },
    lastError: { type: Schema.Types.Mixed },
    lastSyncedAt: { type: Date },
    lastSyncedMtime: { type: Schema.Types.Mixed },
    lockToken: { type: String },
    unlinked: { type: Boolean },
    unlinkReason: { type: String },
    unlinkedAt: { type: Date },
    outboundDirtyAt: { type: Date },
    backoffUntil: { type: Date },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
  },
  { collection: 'googleDriveProjectStates', minimize: false }
)

GoogleDriveProjectStatesSchema.index(
  { projectId: 1 },
  { unique: true, sparse: true }
)
GoogleDriveProjectStatesSchema.index({ userId: 1 })
GoogleDriveProjectStatesSchema.index(
  { driveFolderId: 1 },
  {
    unique: true,
    partialFilterExpression: { driveFolderId: { $type: 'string' } },
  }
)
GoogleDriveProjectStatesSchema.index(
  { outboundDirtyAt: 1, syncSuspended: 1 },
  { sparse: true }
)

// Finished jobs are kept this long so the UI can still show the last result,
// then Mongo's TTL monitor removes them. Unfinished jobs have no finishedAt.
const FINISHED_JOB_TTL_SECONDS = 30 * 24 * 60 * 60

export const GoogleDriveBulkSyncJobsSchema = new Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
      default: 'queued',
    },
    active: { type: Boolean },
    projects: [
      {
        projectId: { type: ObjectId, ref: 'Project' },
        name: { type: String },
        status: { type: String },
        error: { type: String },
      },
    ],
    leaseExpiresAt: { type: Date },
    finishedAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'googleDriveBulkSyncJobs', minimize: false }
)

GoogleDriveBulkSyncJobsSchema.index(
  { userId: 1 },
  {
    name: 'userId_1_active',
    unique: true,
    partialFilterExpression: { active: true },
  }
)
GoogleDriveBulkSyncJobsSchema.index({ userId: 1, createdAt: -1 })
GoogleDriveBulkSyncJobsSchema.index({ active: 1, leaseExpiresAt: 1 })
GoogleDriveBulkSyncJobsSchema.index(
  { finishedAt: 1 },
  { expireAfterSeconds: FINISHED_JOB_TTL_SECONDS }
)

export const GoogleDriveImportJobsSchema = new Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
      default: 'queued',
    },
    active: { type: Boolean },
    folders: [
      {
        folderId: { type: String },
        name: { type: String },
        status: { type: String },
        projectId: { type: ObjectId, ref: 'Project' },
        error: { type: String },
      },
    ],
    leaseExpiresAt: { type: Date },
    finishedAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'googleDriveImportJobs', minimize: false }
)

GoogleDriveImportJobsSchema.index(
  { userId: 1 },
  {
    name: 'userId_1_active',
    unique: true,
    partialFilterExpression: { active: true },
  }
)
GoogleDriveImportJobsSchema.index({ userId: 1, createdAt: -1 })
GoogleDriveImportJobsSchema.index({ active: 1, leaseExpiresAt: 1 })
GoogleDriveImportJobsSchema.index(
  { finishedAt: 1 },
  { expireAfterSeconds: FINISHED_JOB_TTL_SECONDS }
)

export const GoogleDriveUserCredentials = mongoose.model(
  'GoogleDriveUserCredentials',
  GoogleDriveUserCredentialsSchema
)

export const GoogleDriveProjectStates = mongoose.model(
  'GoogleDriveProjectStates',
  GoogleDriveProjectStatesSchema
)

export const GoogleDriveBulkSyncJobs = mongoose.model(
  'GoogleDriveBulkSyncJobs',
  GoogleDriveBulkSyncJobsSchema
)

export const GoogleDriveImportJobs = mongoose.model(
  'GoogleDriveImportJobs',
  GoogleDriveImportJobsSchema
)

// The credential and project-state indexes. Several were first created by
// migrations that are gone now, so the names and options here match those
// exactly: on an instance that ran them, creating them again is a no-op.
const STATE_INDEXES = {
  googleDriveUserCredentials: [
    { key: { user_id: 1 }, name: 'user_id_1', unique: true },
    // The webhook resolves the user from the channel id Google sends
    { key: { watchChannelId: 1 }, name: 'watchChannelId_1' },
  ],
  googleDriveProjectStates: [
    { key: { projectId: 1 }, name: 'projectId_1', unique: true },
    { key: { userId: 1 }, name: 'userId_1' },
    // Unique among states that have one, so two concurrent scans cannot bind
    // one Drive folder to two projects
    {
      key: { driveFolderId: 1 },
      name: 'driveFolderId_1_unique',
      unique: true,
      partialFilterExpression: { driveFolderId: { $type: 'string' } },
    },
    // The outbound worker's query
    {
      key: { outboundDirtyAt: 1, syncSuspended: 1 },
      name: 'outboundDirtyAt_1_syncSuspended_1',
      sparse: true,
    },
  ],
}

/**
 * Creates the credential and project-state indexes. Mongoose autoIndex is off
 * in this app, so the schema declarations above do nothing on their own. Each
 * index is created on its own, so one that fails does not keep the others from
 * being created. Only the module calls this, and only when enabled.
 *
 * @returns {Promise<void>}
 */
export async function ensureProjectStateIndexes() {
  const { db } = await import(
    '../../../../../app/src/infrastructure/mongodb.mjs'
  )
  const failures = []
  for (const [collectionName, indexes] of Object.entries(STATE_INDEXES)) {
    for (const { key, ...options } of indexes) {
      try {
        await db[collectionName].createIndex(key, options)
      } catch (err) {
        failures.push(`${collectionName}: ${err.message}`)
      }
    }
  }
  if (failures.length) {
    throw new Error(`state indexes not created: ${failures.join('; ')}`)
  }
}

/**
 * Creates the indexes on the bulk and import job collections. Each job's
 * partial unique index on userId is what prevents two concurrent jobs for one
 * user. Mongoose autoIndex is off in this app, so the schema declarations above
 * do nothing unless this runs. Only the module calls it, and only when enabled.
 *
 * The names match the ones the removed migrations created, so on an instance
 * that ran them those indexes are left as they are. Each index is created on
 * its own, so one that fails does not keep the others from being created.
 *
 * @returns {Promise<void>}
 */
export async function ensureJobIndexes() {
  const failures = []
  for (const model of [GoogleDriveBulkSyncJobs, GoogleDriveImportJobs]) {
    for (const [key, options] of model.schema.indexes()) {
      try {
        await model.collection.createIndex(key, options)
      } catch (err) {
        failures.push(`${model.collection.collectionName}: ${err.message}`)
      }
    }
  }
  if (failures.length) {
    throw new Error(`job indexes not created: ${failures.join('; ')}`)
  }
}
