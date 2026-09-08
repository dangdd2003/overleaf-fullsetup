import { describe, it, expect, vi, beforeEach } from 'vitest'
import AccessTokenEncryptor from '../../../../../../../libraries/access-token-encryptor/lib/js/AccessTokenEncryptor.js'

const TEST_SECRET = 'a-32-char-test-secret-for-cipher'

const inMemory = new Map()

const mockModel = {
  GithubSyncUserCredentials: {
    findOne: async ({ user_id }) => inMemory.get(String(user_id)) || null,
    findOneAndUpdate: async (query, update) => {
      const key = String(query.user_id)
      const existing = inMemory.get(key) || { user_id: query.user_id }
      const doc = { ...existing, ...(update.$set || {}) }
      inMemory.set(key, doc)
      return doc
    },
    deleteOne: async ({ user_id }) => {
      inMemory.delete(String(user_id))
      return { deletedCount: 1 }
    },
    updateOne: async (query, update) => {
      const doc = inMemory.get(String(query.user_id))
      if (doc && update.$set) Object.assign(doc, update.$set)
      return { modifiedCount: doc ? 1 : 0 }
    },
  },
}

describe('GitHubCredentialsManager', function () {
  let manager

  beforeEach(async function () {
    inMemory.clear()
    vi.resetModules()
    vi.doMock('@overleaf/access-token-encryptor', () => ({
      default: AccessTokenEncryptor,
      __esModule: true,
    }))
    vi.doMock('@overleaf/logger', () => ({
      default: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      __esModule: true,
    }))
    vi.doMock('@overleaf/settings', () => ({
      default: {
        githubSyncEncryptorOptions: {
          cipherLabel: '2026.1-v3',
          cipherPasswords: { '2026.1-v3': TEST_SECRET },
        },
      },
      __esModule: true,
    }))
    vi.doMock('../../../app/src/models/GithubSyncModels.mjs', () => mockModel)
    manager = (await import('../../../app/src/GitHubCredentialsManager.mjs'))
      .default
  })

  it('encrypts and decrypts an access token round-trip', async function () {
    const encrypted = await manager.promises.encryptAccessToken({
      accessToken: 'gho_secret123',
    })
    expect(encrypted).to.be.a('string')
    expect(encrypted).to.not.contain('gho_secret123')
    expect(encrypted.startsWith('2026.1-v3:')).to.equal(true)
    const decrypted = await manager.promises.decryptAccessToken(encrypted)
    expect(decrypted).to.deep.equal({ accessToken: 'gho_secret123' })
  })

  it('stores credentials encrypted and returns the doc without the plaintext', async function () {
    const doc = await manager.promises.storeCredentials('user-1', {
      githubUserId: 42,
      githubUsername: 'octocat',
      email: 'octo@example.com',
      accessToken: 'gho_secret123',
      scope: ['repo', 'user:email'],
    })
    expect(doc.githubUsername).to.equal('octocat')
    expect(doc.encryptedAccessToken).to.not.contain('gho_secret123')
  })

  it('getAccessToken decrypts the stored token', async function () {
    await manager.promises.storeCredentials('user-1', {
      githubUserId: 42,
      githubUsername: 'octocat',
      email: 'octo@example.com',
      accessToken: 'gho_secret123',
      scope: [],
    })
    expect(await manager.promises.getAccessToken('user-1')).to.equal(
      'gho_secret123'
    )
  })

  it('getAccessToken throws when no credentials exist', async function () {
    try {
      await manager.promises.getAccessToken('missing')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err.message).to.contain('not linked')
    }
  })

  it('deleteCredentials removes stored credentials', async function () {
    await manager.promises.storeCredentials('user-1', {
      githubUserId: 42,
      githubUsername: 'octocat',
      email: 'octo@example.com',
      accessToken: 'gho_secret123',
      scope: [],
    })
    await manager.promises.deleteCredentials('user-1')
    expect(await manager.promises.getCredentials('user-1')).to.be.null
  })

  it('touch updates lastUsedAt timestamp', async function () {
    await manager.promises.storeCredentials('user-1', {
      githubUserId: 42,
      githubUsername: 'octocat',
      email: 'octo@example.com',
      accessToken: 'gho_secret123',
      scope: [],
    })
    await manager.promises.touch('user-1')
    const doc = await manager.promises.getCredentials('user-1')
    expect(doc.lastUsedAt).to.be.instanceOf(Date)
  })

  it('throws error when encryption is not configured', async function () {
    vi.resetModules()
    vi.doMock('@overleaf/access-token-encryptor', () => ({
      default: AccessTokenEncryptor,
      __esModule: true,
    }))
    vi.doMock('@overleaf/logger', () => ({
      default: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      __esModule: true,
    }))
    vi.doMock('@overleaf/settings', () => ({
      default: {},
      __esModule: true,
    }))
    vi.doMock('../../../app/src/models/GithubSyncModels.mjs', () => mockModel)
    const unconfiguredManager = (
      await import('../../../app/src/GitHubCredentialsManager.mjs')
    ).default

    await expect(
      unconfiguredManager.promises.encryptAccessToken({ accessToken: 'test' })
    ).to.be.rejectedWith(
      'GitHub token encryption not configured; set GITHUB_TOKEN_SECRET'
    )
  })
})
