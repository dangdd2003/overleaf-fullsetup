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
  { unique: true, partialFilterExpression: { active: true } }
)
GoogleDriveBulkSyncJobsSchema.index({ active: 1, leaseExpiresAt: 1 })

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
  { unique: true, partialFilterExpression: { active: true } }
)
GoogleDriveImportJobsSchema.index({ active: 1, leaseExpiresAt: 1 })

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

/**
 * Creates the project-state indexes that the migration does not cover.
 *
 * - driveFolderId is unique among states that have one, so two concurrent
 *   scans cannot bind one Drive folder to two projects.
 * - {outboundDirtyAt, syncSuspended} matches the outbound worker's query.
 *
 * Explicit names are used because the migration already created
 * `projectId_1` and `outboundDirtyAt_1` with different options, and Mongoose
 * would collide with them. Only the module calls this, and only when enabled.
 *
 * @returns {Promise<void>}
 */
export async function ensureProjectStateIndexes() {
  const { db } = await import(
    '../../../../../app/src/infrastructure/mongodb.mjs'
  )
  await Promise.all([
    db.googleDriveProjectStates.createIndex(
      { driveFolderId: 1 },
      {
        name: 'driveFolderId_1_unique',
        unique: true,
        partialFilterExpression: { driveFolderId: { $type: 'string' } },
      }
    ),
    db.googleDriveProjectStates.createIndex(
      { outboundDirtyAt: 1, syncSuspended: 1 },
      {
        name: 'outboundDirtyAt_1_syncSuspended_1',
        sparse: true,
      }
    ),
  ])
}

/**
 * Creates the indexes on the bulk and import job collections. Each job's
 * partial unique index on userId is what prevents two concurrent jobs for one
 * user. Mongoose autoIndex is off in this app, so the schema declarations above
 * do nothing unless this runs. Only the module calls it, and only when enabled.
 *
 * @returns {Promise<void>}
 */
export async function ensureJobIndexes() {
  await Promise.all([
    GoogleDriveBulkSyncJobs.createIndexes(),
    GoogleDriveImportJobs.createIndexes(),
  ])
}
