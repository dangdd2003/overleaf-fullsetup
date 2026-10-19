import { describe, it, expect, vi, beforeEach } from 'vitest'

class MockSchema {
  constructor(definition, options = {}) {
    this.definition = definition
    this.options = options
    this.paths = {}
    this.indexesList = []
    this._buildPaths('', definition)
  }

  index(fields, options = {}) {
    this.indexesList.push({ fields, options })
  }

  _buildPaths(prefix, def) {
    if (Array.isArray(def)) {
      this.paths[prefix] = { options: { type: def } }
      return
    }
    for (const [key, val] of Object.entries(def)) {
      const fullPath = prefix ? `${prefix}.${key}` : key
      if (val && typeof val === 'object' && !Array.isArray(val) && !val.type) {
        this._buildPaths(fullPath, val)
      } else {
        this.paths[fullPath] = {
          options:
            val && typeof val === 'object' && !Array.isArray(val) && val.type
              ? val
              : { type: val },
        }
      }
    }
  }
}
MockSchema.ObjectId = 'ObjectId'
MockSchema.Types = { Mixed: 'Mixed' }

const mockMongoose = {
  Schema: MockSchema,
  model: (name, schema) => {
    return class {
      static modelName = name
      static schema = schema
      static collection = {
        name: schema.options.collection || name,
      }
    }
  },
}

describe('GoogleDriveSyncModels', function () {
  beforeEach(function () {
    vi.resetModules()
    vi.doMock(
      '../../../../../app/src/infrastructure/Mongoose.mjs',
      () => ({
        default: mockMongoose,
        __esModule: true,
      })
    )
  })

  describe('GoogleDriveUserCredentials', function () {
    it('defines credentials schema with all required fields, options and indexes', async function () {
      const {
        GoogleDriveUserCredentials,
        GoogleDriveUserCredentialsSchema,
      } = await import('../../../app/src/models/GoogleDriveSyncModels.mjs')

      expect(GoogleDriveUserCredentialsSchema).to.exist
      expect(GoogleDriveUserCredentials).to.exist

      const paths = GoogleDriveUserCredentials.schema.paths
      expect(paths.user_id.options.type).to.equal('ObjectId')
      expect(paths.user_id.options.ref).to.equal('User')
      expect(paths.user_id.options.required).to.equal(true)
      expect(paths.user_id.options.unique).to.equal(true)

      expect(paths.googleEmail.options.type).to.equal(String)
      expect(paths.googleUserId.options.type).to.equal(String)
      expect(paths.encryptedAccessToken.options.type).to.equal(String)
      expect(paths.encryptedRefreshToken.options.type).to.equal(String)
      expect(paths.tokenExpiry.options.type).to.equal(Date)
      expect(paths.linkedAt.options.type).to.equal(Date)
      expect(paths.startPageToken.options.type).to.equal(String)
      expect(paths.watchChannelId.options.type).to.equal(String)
      expect(paths.watchResourceId.options.type).to.equal(String)
      expect(paths.watchChannelToken.options.type).to.equal(String)
      expect(paths.watchExpiresAt.options.type).to.equal(Date)
      expect(paths.consecutiveAuthErrors.options.type).to.equal(Number)
      expect(paths.consecutiveAuthErrors.options.default).to.equal(0)

      expect(GoogleDriveUserCredentials.collection.name).to.equal(
        'googleDriveUserCredentials'
      )
      expect(
        GoogleDriveUserCredentials.schema.options.collection
      ).to.equal('googleDriveUserCredentials')
      expect(GoogleDriveUserCredentials.schema.options.minimize).to.equal(false)

      const indexes = GoogleDriveUserCredentials.schema.indexesList
      expect(indexes.some(idx => idx.fields.watchChannelId === 1)).to.be.true
    })
  })

  describe('GoogleDriveProjectStates', function () {
    it('defines project states schema with all required fields, options and indexes', async function () {
      const {
        GoogleDriveProjectStates,
        GoogleDriveProjectStatesSchema,
      } = await import('../../../app/src/models/GoogleDriveSyncModels.mjs')

      expect(GoogleDriveProjectStatesSchema).to.exist
      expect(GoogleDriveProjectStates).to.exist

      const paths = GoogleDriveProjectStates.schema.paths
      expect(paths.projectId.options.type).to.equal('ObjectId')
      expect(paths.projectId.options.ref).to.equal('Project')

      expect(paths.userId.options.type).to.equal('ObjectId')
      expect(paths.userId.options.ref).to.equal('User')
      expect(paths.userId.options.required).to.equal(true)

      expect(paths.driveFolderId.options.type).to.equal(String)
      expect(paths.folderName.options.type).to.equal(String)

      expect(paths.syncStatus.options.type).to.equal(String)
      expect(paths.syncStatus.options.enum).to.deep.equal([
        'idle',
        'syncing',
        'error',
        'pending',
      ])
      expect(paths.syncStatus.options.default).to.equal('idle')

      expect(paths.isSyncing.options.type).to.equal(Boolean)
      expect(paths.isSyncing.options.default).to.equal(false)

      expect(paths.lockExpiresAt.options.type).to.equal(Date)
      expect(paths.syncSuspended.options.type).to.equal(Boolean)
      expect(paths.syncSuspended.options.default).to.equal(false)
      expect(paths.suspendReason.options.type).to.equal(String)

      expect(GoogleDriveProjectStates.collection.name).to.equal(
        'googleDriveProjectStates'
      )
      expect(
        GoogleDriveProjectStates.schema.options.collection
      ).to.equal('googleDriveProjectStates')
      expect(GoogleDriveProjectStates.schema.options.minimize).to.equal(false)

      const indexes = GoogleDriveProjectStates.schema.indexesList
      expect(
        indexes.some(
          idx =>
            idx.fields.projectId === 1 &&
            idx.options.unique === true &&
            idx.options.sparse === true
        )
      ).to.be.true
      expect(indexes.some(idx => idx.fields.userId === 1)).to.be.true
      const driveFolderIndex = indexes.find(
        idx => idx.fields.driveFolderId === 1
      )
      expect(driveFolderIndex.options.unique).to.equal(true)
      expect(driveFolderIndex.options.partialFilterExpression).to.deep.equal({
        driveFolderId: { $type: 'string' },
      })
      expect(
        indexes.some(
          idx =>
            idx.fields.outboundDirtyAt === 1 && idx.fields.syncSuspended === 1
        )
      ).to.be.true
    })
  })

  describe('GoogleDriveBulkSyncJobs', function () {
    it('defines bulk sync jobs schema with all required fields, options and indexes', async function () {
      const {
        GoogleDriveBulkSyncJobs,
        GoogleDriveBulkSyncJobsSchema,
      } = await import('../../../app/src/models/GoogleDriveSyncModels.mjs')

      expect(GoogleDriveBulkSyncJobsSchema).to.exist
      expect(GoogleDriveBulkSyncJobs).to.exist

      const paths = GoogleDriveBulkSyncJobs.schema.paths
      expect(paths.userId.options.type).to.equal('ObjectId')
      expect(paths.userId.options.ref).to.equal('User')
      expect(paths.userId.options.required).to.equal(true)

      expect(paths.status.options.type).to.equal(String)
      expect(paths.status.options.enum).to.deep.equal([
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled',
      ])
      expect(paths.status.options.default).to.equal('queued')

      expect(paths.active.options.type).to.equal(Boolean)

      expect(GoogleDriveBulkSyncJobs.collection.name).to.equal(
        'googleDriveBulkSyncJobs'
      )
      expect(
        GoogleDriveBulkSyncJobs.schema.options.collection
      ).to.equal('googleDriveBulkSyncJobs')
      expect(GoogleDriveBulkSyncJobs.schema.options.minimize).to.equal(false)

      const indexes = GoogleDriveBulkSyncJobs.schema.indexesList
      expect(
        indexes.some(
          idx =>
            idx.fields.userId === 1 &&
            idx.options.unique === true &&
            idx.options.partialFilterExpression?.active === true
        )
      ).to.be.true
      expect(
        indexes.some(
          idx => idx.fields.active === 1 && idx.fields.leaseExpiresAt === 1
        )
      ).to.be.true
    })
  })

  describe('GoogleDriveImportJobs', function () {
    it('defines import jobs schema with all required fields, options and indexes', async function () {
      const {
        GoogleDriveImportJobs,
        GoogleDriveImportJobsSchema,
      } = await import('../../../app/src/models/GoogleDriveSyncModels.mjs')

      expect(GoogleDriveImportJobsSchema).to.exist
      expect(GoogleDriveImportJobs).to.exist

      const paths = GoogleDriveImportJobs.schema.paths
      expect(paths.userId.options.type).to.equal('ObjectId')
      expect(paths.userId.options.ref).to.equal('User')
      expect(paths.userId.options.required).to.equal(true)

      expect(paths.status.options.type).to.equal(String)
      expect(paths.status.options.enum).to.deep.equal([
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled',
      ])
      expect(paths.status.options.default).to.equal('queued')

      expect(paths.active.options.type).to.equal(Boolean)

      expect(GoogleDriveImportJobs.collection.name).to.equal(
        'googleDriveImportJobs'
      )
      expect(
        GoogleDriveImportJobs.schema.options.collection
      ).to.equal('googleDriveImportJobs')
      expect(GoogleDriveImportJobs.schema.options.minimize).to.equal(false)

      const indexes = GoogleDriveImportJobs.schema.indexesList
      expect(
        indexes.some(
          idx =>
            idx.fields.userId === 1 &&
            idx.options.unique === true &&
            idx.options.partialFilterExpression?.active === true
        )
      ).to.be.true
      expect(
        indexes.some(
          idx => idx.fields.active === 1 && idx.fields.leaseExpiresAt === 1
        )
      ).to.be.true
    })
  })
})

describe('ensureProjectStateIndexes', function () {
  it('creates the credential and project-state indexes', async function () {
    vi.resetModules()
    const createIndex = vi.fn().mockResolvedValue('ok')
    const credentialsCreateIndex = vi.fn().mockResolvedValue('ok')
    vi.doMock(
      '../../../../../app/src/infrastructure/Mongoose.mjs',
      () => ({ default: mockMongoose, __esModule: true })
    )
    vi.doMock(
      '../../../../../app/src/infrastructure/mongodb.mjs',
      () => ({
        db: {
          googleDriveProjectStates: { createIndex },
          googleDriveUserCredentials: { createIndex: credentialsCreateIndex },
        },
      })
    )
    const { ensureProjectStateIndexes } = await import(
      '../../../app/src/models/GoogleDriveSyncModels.mjs'
    )

    await ensureProjectStateIndexes()

    expect(createIndex).toHaveBeenCalledWith(
      { driveFolderId: 1 },
      expect.objectContaining({
        name: 'driveFolderId_1_unique',
        unique: true,
        partialFilterExpression: { driveFolderId: { $type: 'string' } },
      })
    )
    expect(createIndex).toHaveBeenCalledWith(
      { outboundDirtyAt: 1, syncSuspended: 1 },
      expect.objectContaining({ name: 'outboundDirtyAt_1_syncSuspended_1' })
    )
    // Same names and options as the removed migrations, so existing indexes
    // are left as they are
    expect(createIndex).toHaveBeenCalledWith(
      { projectId: 1 },
      { name: 'projectId_1', unique: true }
    )
    expect(createIndex).toHaveBeenCalledWith({ userId: 1 }, { name: 'userId_1' })
    expect(credentialsCreateIndex).toHaveBeenCalledWith(
      { user_id: 1 },
      { name: 'user_id_1', unique: true }
    )
    expect(credentialsCreateIndex).toHaveBeenCalledWith(
      { watchChannelId: 1 },
      { name: 'watchChannelId_1' }
    )
  })

  it('creates the remaining indexes when one fails, then reports it', async function () {
    vi.resetModules()
    const createIndex = vi
      .fn()
      .mockRejectedValueOnce(new Error('E11000 duplicate key'))
      .mockResolvedValue('ok')
    vi.doMock(
      '../../../../../app/src/infrastructure/Mongoose.mjs',
      () => ({ default: mockMongoose, __esModule: true })
    )
    vi.doMock(
      '../../../../../app/src/infrastructure/mongodb.mjs',
      () => ({
        db: {
          googleDriveProjectStates: { createIndex },
          googleDriveUserCredentials: { createIndex },
        },
      })
    )
    const { ensureProjectStateIndexes } = await import(
      '../../../app/src/models/GoogleDriveSyncModels.mjs'
    )

    const err = await ensureProjectStateIndexes().catch(error => error)
    expect(err.message).to.match(/E11000/)
    expect(createIndex).toHaveBeenCalledTimes(6)
  })
})
