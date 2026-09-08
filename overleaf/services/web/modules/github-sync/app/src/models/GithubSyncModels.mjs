import mongoose from '../../../../../app/src/infrastructure/Mongoose.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

export const GithubSyncUserCredentialsSchema = new Schema(
  {
    user_id: { type: ObjectId, ref: 'User', required: true, unique: true },
    githubUserId: { type: Number, required: true },
    githubUsername: { type: String, required: true },
    email: { type: String, required: true },
    encryptedAccessToken: { type: String, required: true },
    scope: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date },
  },
  { collection: 'githubSyncUserCredentials', minimize: false }
)

export const GithubSyncProjectStatesSchema = new Schema(
  {
    project_id: {
      type: ObjectId,
      ref: 'Project',
      required: true,
      unique: true,
    },
    user_id: { type: ObjectId, ref: 'User', required: true },
    repo: {
      owner: { type: String, required: true },
      name: { type: String, required: true },
    },
    repoDefaultBranch: { type: String, required: true },
    lastSyncedCommitSha: { type: String },
    syncState: {
      type: String,
      enum: ['idle', 'syncing', 'conflict', 'error'],
      default: 'idle',
    },
    syncLock: {
      lockedAt: { type: Date },
      expiresAt: { type: Date },
    },
    outgoing: { type: Boolean, default: false },
    status: {
      incomingCommits: { type: Number },
      checkedAt: { type: Date },
    },
    lastError: {
      code: { type: String },
      message: { type: String },
      at: { type: Date },
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
  },
  { collection: 'githubSyncProjectStates', minimize: false }
)

export const GithubSyncUserCredentials = mongoose.model(
  'GithubSyncUserCredentials',
  GithubSyncUserCredentialsSchema
)

export const GithubSyncProjectStates = mongoose.model(
  'GithubSyncProjectStates',
  GithubSyncProjectStatesSchema
)
