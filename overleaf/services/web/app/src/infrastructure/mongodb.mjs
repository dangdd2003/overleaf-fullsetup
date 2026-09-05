import mongodb from 'mongodb-legacy'
import OError from '@overleaf/o-error'
import Settings from '@overleaf/settings'
import MongoUtils from '@overleaf/mongo-utils'
import Mongoose from './Mongoose.mjs'
import { addConnectionDrainer } from './GracefulShutdown.mjs'
import Metrics from '@overleaf/metrics'

// Ensure Mongoose is using the same mongodb instance as the mongodb module,
// otherwise we will get multiple versions of the ObjectId class. Mongoose
// patches ObjectId, so loading multiple versions of the mongodb module can
// cause problems with ObjectId comparisons.
if (Mongoose.mongo.ObjectId !== mongodb.ObjectId) {
  throw new OError(
    'FATAL ERROR: Mongoose is using a different mongodb instance'
  )
}

export const { ObjectId } = mongodb
const { ReadPreference } = mongodb

export const READ_PREFERENCE_PRIMARY = ReadPreference.primary.mode
export const READ_PREFERENCE_SECONDARY = Settings.mongo.hasSecondaries
  ? ReadPreference.secondary.mode
  : ReadPreference.secondaryPreferred.mode

const mongoClient = new mongodb.MongoClient(
  Settings.mongo.url,
  Settings.mongo.options
)
Metrics.mongodb.monitor(mongoClient, 'native')

addConnectionDrainer('mongodb', async () => {
  await mongoClient.close()
})

const internalDb = mongoClient.db()
export const db = {
  contacts: internalDb.collection('contacts'),
  deletedProjects: internalDb.collection('deletedProjects'),
  deletedSubscriptions: internalDb.collection('deletedSubscriptions'),
  deletedUsers: internalDb.collection('deletedUsers'),
  domainVerifications: internalDb.collection('domainVerifications'),
  dropboxEntities: internalDb.collection('dropboxEntities'),
  dropboxProjects: internalDb.collection('dropboxProjects'),
  docSnapshots: internalDb.collection('docSnapshots'),
  docs: internalDb.collection('docs'),
  feedbacks: internalDb.collection('feedbacks'),
  githubSyncEntityVersions: internalDb.collection('githubSyncEntityVersions'),
  githubSyncProjectStates: internalDb.collection('githubSyncProjectStates'),
  githubSyncUserCredentials: internalDb.collection('githubSyncUserCredentials'),
  globalMetrics: internalDb.collection('globalMetrics'),
  googleDriveProjectStates: internalDb.collection('googleDriveProjectStates'),
  googleDriveUserCredentials: internalDb.collection(
    'googleDriveUserCredentials'
  ),
  grouppolicies: internalDb.collection('grouppolicies'),
  groupAuditLogEntries: internalDb.collection('groupAuditLogEntries'),
  institutions: internalDb.collection('institutions'),
  libraryReferences: internalDb.collection('libraryReferences'),
  librarySyncStates: internalDb.collection('librarySyncStates'),
  messages: internalDb.collection('messages'),
  migrations: internalDb.collection('migrations'),
  notifications: internalDb.collection('notifications'),
  emailNotifications: internalDb.collection('emailNotifications'),
  notificationsPreferences: internalDb.collection('notificationsPreferences'),
  oauthAccessTokens: internalDb.collection('oauthAccessTokens'),
  oauthApplications: internalDb.collection('oauthApplications'),
  oauthAuthorizationCodes: internalDb.collection('oauthAuthorizationCodes'),
  projectAuditLogEntries: internalDb.collection('projectAuditLogEntries'),
  projectHistoryChunks: internalDb.collection('projectHistoryChunks'),
  projectHistoryFailures: internalDb.collection('projectHistoryFailures'),
  projectHistoryGlobalBlobs: internalDb.collection('projectHistoryGlobalBlobs'),
  projectHistoryLabels: internalDb.collection('projectHistoryLabels'),
  projectHistorySizes: internalDb.collection('projectHistorySizes'),
  projectHistorySyncState: internalDb.collection('projectHistorySyncState'),
  projectInvites: internalDb.collection('projectInvites'),
  projects: internalDb.collection('projects'),
  publishers: internalDb.collection('publishers'),
  rooms: internalDb.collection('rooms'),
  samlCache: internalDb.collection('samlCache'),
  samlLogs: internalDb.collection('samlLogs'),
  spellingPreferences: internalDb.collection('spellingPreferences'),
  splittests: internalDb.collection('splittests'),
  ssoConfigs: internalDb.collection('ssoConfigs'),
  subscriptions: internalDb.collection('subscriptions'),
  surveys: internalDb.collection('surveys'),
  systemmessages: internalDb.collection('systemmessages'),
  tags: internalDb.collection('tags'),
  teamInvites: internalDb.collection('teamInvites'),
  tokens: internalDb.collection('tokens'),
  userAuditLogEntries: internalDb.collection('userAuditLogEntries'),
  users: internalDb.collection('users'),
  onboardingDataCollection: internalDb.collection('onboardingDataCollection'),
  scriptLogs: internalDb.collection('scriptLogs'),
}

export const connectionPromise = mongoClient.connect()

export async function getCollectionNames() {
  const internalDb = mongoClient.db()

  const collections = await internalDb.collections()
  return collections.map(collection => collection.collectionName)
}

export async function cleanupTestDatabase() {
  await MongoUtils.cleanupTestDatabase(mongoClient)
}

export async function dropTestDatabase() {
  await MongoUtils.dropTestDatabase(mongoClient)
}

/**
 * WARNING: Consider using a pre-populated collection from `db` to avoid typos!
 */
export async function getCollectionInternal(name) {
  const internalDb = mongoClient.db()
  return internalDb.collection(name)
}

export async function waitForDb() {
  await connectionPromise
}

const { Schema } = Mongoose

export const GoogleDriveUserCredentialsSchema = new Schema(
  {
    user_id: { type: ObjectId, ref: 'User', index: true, unique: true },
    googleEmail: String,
    googleUserId: String,
    encryptedAccessToken: String,
    encryptedRefreshToken: String,
    tokenExpiry: Date,
    rootFolderId: String,
    startPageToken: String,
    watchChannelId: { type: String, index: true },
    watchResourceId: String,
    watchChannelToken: String,
    watchExpiresAt: Date,
    linkedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'googleDriveUserCredentials' }
)

export const GoogleDriveProjectStatesSchema = new Schema(
  {
    projectId: { type: ObjectId, ref: 'Project', index: true, unique: true },
    userId: { type: ObjectId, ref: 'User', index: true },
    driveFolderId: String,
    folderName: String,
    fileMap: { type: Map, of: Schema.Types.Mixed, default: {} },
    syncStatus: {
      type: String,
      enum: ['idle', 'syncing', 'error'],
      default: 'idle',
    },
    lastSyncedAt: Date,
    lastError: String,
    isSyncing: { type: Boolean, default: false },
    lockExpiresAt: Date,
    pendingChanges: { type: Map, of: Schema.Types.Mixed, default: {} },
    outboundDirtyAt: Date,
    lastOutboundError: String,
    backoffUntil: Date,
    consecutiveFailures: { type: Number, default: 0 },
    syncSuspended: { type: Boolean, default: false },
    suspendReason: String,
  },
  { collection: 'googleDriveProjectStates' }
)

export const GoogleDriveUserCredentials = Mongoose.model(
  'GoogleDriveUserCredentials',
  GoogleDriveUserCredentialsSchema
)

export const GoogleDriveProjectStates = Mongoose.model(
  'GoogleDriveProjectStates',
  GoogleDriveProjectStatesSchema
)

export default {
  db,
  ObjectId,
  GoogleDriveUserCredentialsSchema,
  GoogleDriveProjectStatesSchema,
  GoogleDriveUserCredentials,
  GoogleDriveProjectStates,
  connectionPromise,
  waitForDb,
  getCollectionNames,
  getCollectionInternal,
  cleanupTestDatabase,
  dropTestDatabase,
  READ_PREFERENCE_PRIMARY,
  READ_PREFERENCE_SECONDARY,
}
