import { describe, it, expect, vi, beforeEach } from 'vitest'

class MockSchema {
  constructor(definition, options = {}) {
    this.definition = definition
    this.options = options
    this.paths = {}
    this._buildPaths('', definition)
  }

  _buildPaths(prefix, def) {
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

describe('GithubSyncModels', function () {
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

  describe('GithubSyncUserCredentials', function () {
    it('defines credentials schema with all required fields and options', async function () {
      const {
        GithubSyncUserCredentials,
        GithubSyncUserCredentialsSchema,
      } = await import('../../../app/src/models/GithubSyncModels.mjs')

      expect(GithubSyncUserCredentialsSchema).to.exist
      expect(GithubSyncUserCredentials).to.exist

      const paths = GithubSyncUserCredentials.schema.paths
      expect(paths.user_id.options.type).to.equal('ObjectId')
      expect(paths.user_id.options.ref).to.equal('User')
      expect(paths.user_id.options.required).to.equal(true)
      expect(paths.user_id.options.unique).to.equal(true)

      expect(paths.githubUserId.options.type).to.equal(Number)
      expect(paths.githubUserId.options.required).to.equal(true)

      expect(paths.githubUsername.options.type).to.equal(String)
      expect(paths.githubUsername.options.required).to.equal(true)

      expect(paths.email.options.type).to.equal(String)
      expect(paths.email.options.required).to.equal(true)

      expect(paths.encryptedAccessToken.options.type).to.equal(String)
      expect(paths.encryptedAccessToken.options.required).to.equal(true)

      expect(paths.scope.options.type).to.deep.equal([String])
      expect(paths.scope.options.default).to.deep.equal([])

      expect(paths.createdAt.options.type).to.equal(Date)
      expect(paths.createdAt.options.default).to.equal(Date.now)

      expect(paths.lastUsedAt.options.type).to.equal(Date)

      expect(GithubSyncUserCredentials.collection.name).to.equal(
        'githubSyncUserCredentials'
      )
      expect(GithubSyncUserCredentials.schema.options.collection).to.equal(
        'githubSyncUserCredentials'
      )
      expect(GithubSyncUserCredentials.schema.options.minimize).to.equal(false)
    })
  })

  describe('GithubSyncProjectStates', function () {
    it('defines project states schema with all required fields, enums and options', async function () {
      const {
        GithubSyncProjectStates,
        GithubSyncProjectStatesSchema,
      } = await import('../../../app/src/models/GithubSyncModels.mjs')

      expect(GithubSyncProjectStatesSchema).to.exist
      expect(GithubSyncProjectStates).to.exist

      const paths = GithubSyncProjectStates.schema.paths
      expect(paths.project_id.options.type).to.equal('ObjectId')
      expect(paths.project_id.options.ref).to.equal('Project')
      expect(paths.project_id.options.required).to.equal(true)
      expect(paths.project_id.options.unique).to.equal(true)

      expect(paths.user_id.options.type).to.equal('ObjectId')
      expect(paths.user_id.options.ref).to.equal('User')
      expect(paths.user_id.options.required).to.equal(true)

      expect(paths['repo.owner'].options.type).to.equal(String)
      expect(paths['repo.owner'].options.required).to.equal(true)
      expect(paths['repo.name'].options.type).to.equal(String)
      expect(paths['repo.name'].options.required).to.equal(true)

      expect(paths.repoDefaultBranch.options.type).to.equal(String)
      expect(paths.repoDefaultBranch.options.required).to.equal(true)

      expect(paths.lastSyncedCommitSha.options.type).to.equal(String)

      expect(paths.syncState.options.type).to.equal(String)
      expect(paths.syncState.options.enum).to.deep.equal([
        'idle',
        'syncing',
        'conflict',
        'error',
      ])
      expect(paths.syncState.options.default).to.equal('idle')

      expect(paths['syncLock.lockedAt'].options.type).to.equal(Date)
      expect(paths['syncLock.expiresAt'].options.type).to.equal(Date)

      expect(paths.outgoing.options.type).to.equal(Boolean)
      expect(paths.outgoing.options.default).to.equal(false)

      expect(paths['status.incomingCommits'].options.type).to.equal(Number)
      expect(paths['status.checkedAt'].options.type).to.equal(Date)

      expect(paths['lastError.code'].options.type).to.equal(String)
      expect(paths['lastError.message'].options.type).to.equal(String)
      expect(paths['lastError.at'].options.type).to.equal(Date)

      expect(paths.createdAt.options.type).to.equal(Date)
      expect(paths.createdAt.options.default).to.equal(Date.now)

      expect(paths.updatedAt.options.type).to.equal(Date)

      expect(GithubSyncProjectStates.collection.name).to.equal(
        'githubSyncProjectStates'
      )
      expect(GithubSyncProjectStates.schema.options.collection).to.equal(
        'githubSyncProjectStates'
      )
      expect(GithubSyncProjectStates.schema.options.minimize).to.equal(false)
    })
  })
})
