import { describe, it, beforeEach, expect } from 'vitest'
import crypto from 'node:crypto'
import { PersonalAccessToken } from '../../../../../app/src/models/PersonalAccessToken.mjs'
import UserGetter from '../../../../../app/src/Features/User/UserGetter.mjs'
import PersonalAccessTokenManager, {
  createToken,
  validateToken,
  listTokens,
  revokeToken,
} from '../../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'

describe('PersonalAccessTokenManager', () => {
  const userId = '64b1f2e3d4c5b6a789012345'
  const userEmail = 'user@example.com'

  let mockCreateRecord
  let mockFindRecord
  let mockUpdateOneResult
  let mockDeleteResult
  let mockUser

  beforeEach(() => {
    mockCreateRecord = null
    mockFindRecord = null
    mockUpdateOneResult = { acknowledged: true, modifiedCount: 1 }
    mockDeleteResult = { acknowledged: true, deletedCount: 1 }
    mockUser = { _id: userId, email: userEmail }

    // Mock PersonalAccessToken model methods
    PersonalAccessToken.create = async doc => {
      mockCreateRecord = {
        _id: 'pat_doc_id_123',
        ...doc,
        save: async function () {
          return this
        },
      }
      return mockCreateRecord
    }

    PersonalAccessToken.findOne = async query => {
      if (mockFindRecord && mockFindRecord.tokenHash === query.tokenHash) {
        return mockFindRecord
      }
      return null
    }

    PersonalAccessToken.find = (query, projection) => {
      return {
        sort: sortOptions => ({
          exec: async () => [
            {
              _id: 'pat_1',
              user_id: query.user_id,
              name: 'Token 1',
              tokenPrefix: 'olp_1111',
              scopes: ['git_bridge'],
              createdAt: new Date('2026-08-20T10:00:00Z'),
            },
            {
              _id: 'pat_2',
              user_id: query.user_id,
              name: 'Token 2',
              tokenPrefix: 'olp_2222',
              scopes: ['git_bridge'],
              createdAt: new Date('2026-08-19T10:00:00Z'),
            },
          ],
        }),
      }
    }

    PersonalAccessToken.updateOne = async () => mockUpdateOneResult
    PersonalAccessToken.deleteOne = async query => mockDeleteResult

    // Mock UserGetter
    UserGetter.promises.getUser = async (queryId, projection) => {
      if (mockUser && mockUser._id.toString() === queryId.toString()) {
        return mockUser
      }
      return null
    }
  })

  describe('createToken', () => {
    it('generates a token with prefix olp_ and 32 hex characters (36 chars total)', async () => {
      const result = await PersonalAccessTokenManager.createToken(userId)

      expect(result.token).toBeDefined()
      expect(typeof result.token).toBe('string')
      expect(result.token.length).toBe(36)
      expect(result.token.startsWith('olp_')).toBe(true)

      const hexPart = result.token.slice(4)
      expect(hexPart).toMatch(/^[0-9a-f]{32}$/)
    })

    it('generates tokenPrefix equal to the first 8 characters of token', async () => {
      const result = await PersonalAccessTokenManager.createToken(userId)

      expect(result.tokenPrefix).toBe(result.token.slice(0, 8))
      expect(result.tokenPrefix.length).toBe(8)
    })

    it('computes sha256 hash and stores in record', async () => {
      const result = await PersonalAccessTokenManager.createToken(userId)

      const expectedHash = crypto
        .createHash('sha256')
        .update(result.token)
        .digest('hex')

      expect(result.record.tokenHash).toBe(expectedHash)
      expect(result.record.user_id).toBe(userId)
    })

    it('uses default name "Git Token" when name is omitted', async () => {
      const result = await PersonalAccessTokenManager.createToken(userId)

      expect(result.record.name).toBe('Git Token')
    })

    it('uses custom name when provided', async () => {
      const customName = 'CI Deploy Key'
      const result = await PersonalAccessTokenManager.createToken(
        userId,
        customName
      )

      expect(result.record.name).toBe(customName)
    })

    it('defaults scopes to ["git_bridge"]', async () => {
      const result = await PersonalAccessTokenManager.createToken(userId)

      expect(result.record.scopes).toEqual(['git_bridge'])
    })

    it('defaults scopes to [git_bridge] when omitted', async () => {
      const { record } = await createToken(userId, 'My Token')
      expect(record.scopes).toEqual(['git_bridge'])
    })

    it('persists the requested scopes', async () => {
      const { record } = await createToken(userId, 'AI', ['mcp'])
      expect(record.scopes).toEqual(['mcp'])
    })

    it('rejects unknown scopes', async () => {
      let err
      try {
        await createToken(userId, 'bad', ['root'])
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect(err.message).toMatch(/scope/i)
    })

    it('works with named export createToken', async () => {
      const result = await createToken(userId)
      expect(result.token).toBeDefined()
    })
  })

  describe('validateToken', () => {
    let validToken
    let validTokenHash

    beforeEach(async () => {
      validToken = 'olp_0123456789abcdef0123456789abcdef'
      validTokenHash = crypto
        .createHash('sha256')
        .update(validToken)
        .digest('hex')

      mockFindRecord = {
        _id: 'pat_doc_id_123',
        user_id: userId,
        tokenHash: validTokenHash,
        tokenPrefix: 'olp_0123',
        scopes: ['git_bridge'],
        createdAt: new Date('2026-08-01T00:00:00Z'),
        lastUsedAt: null,
        expiresAt: null,
        save: async function () {
          return this
        },
      }
    })

    it('returns null for invalid inputs (null, undefined, non-string, empty)', async () => {
      expect(await PersonalAccessTokenManager.validateToken(null)).toBeNull()
      expect(
        await PersonalAccessTokenManager.validateToken(undefined)
      ).toBeNull()
      expect(await PersonalAccessTokenManager.validateToken(12345)).toBeNull()
      expect(await PersonalAccessTokenManager.validateToken('')).toBeNull()
      expect(await PersonalAccessTokenManager.validateToken('   ')).toBeNull()
    })

    it('returns null if token record does not exist', async () => {
      mockFindRecord = null
      const result = await PersonalAccessTokenManager.validateToken(validToken)
      expect(result).toBeNull()
    })

    it('returns null if token has expired', async () => {
      mockFindRecord.expiresAt = new Date(Date.now() - 10000)
      const result = await PersonalAccessTokenManager.validateToken(validToken)
      expect(result).toBeNull()
    })

    it('returns valid info when token is valid and unexpired', async () => {
      mockFindRecord.expiresAt = new Date(Date.now() + 1000000)
      const result = await PersonalAccessTokenManager.validateToken(validToken)

      expect(result).toBeDefined()
      expect(result.userId).toBe(userId)
      expect(result.email).toBe(userEmail)
      expect(result.scopes).toEqual(['git_bridge'])
    })

    it('validateToken returns userId, email and scopes array', async () => {
      const token = 'olp_' + '0'.repeat(32)
      mockFindRecord = {
        user_id: userId,
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        scopes: ['mcp', 'git_bridge'],
        expiresAt: new Date(Date.now() + 1000),
        save: async () => {},
      }
      const info = await validateToken(token)
      expect(info).toEqual({
        userId,
        email: userEmail,
        scopes: ['mcp', 'git_bridge'],
      })
    })

    it('updates lastUsedAt when token is successfully validated', async () => {
      // stored lastUsedAt is old, so the throttled write still fires
      mockFindRecord.lastUsedAt = new Date('2000-01-01T00:00:00Z')
      let saved = false
      mockFindRecord.save = async function () {
        saved = true
        return this
      }

      const result = await PersonalAccessTokenManager.validateToken(validToken)

      expect(result).toBeDefined()
      expect(mockFindRecord.lastUsedAt instanceof Date).toBe(true)
      expect(saved).toBe(true)
    })

    it('falls back to updateOne when record.save is not a function', async () => {
      mockFindRecord.save = null
      let updated = false
      PersonalAccessToken.updateOne = async () => {
        updated = true
        return mockUpdateOneResult
      }

      const result = await PersonalAccessTokenManager.validateToken(validToken)
      expect(result).toBeDefined()
      expect(updated).toBe(true)
    })

    it('returns null if user does not exist in UserGetter', async () => {
      mockUser = null
      const result = await PersonalAccessTokenManager.validateToken(validToken)
      expect(result).toBeNull()
    })

    it('returns multiple scopes as an array', async () => {
      mockFindRecord.scopes = ['git_bridge', 'mcp']
      const result = await PersonalAccessTokenManager.validateToken(validToken)

      expect(result).toBeDefined()
      expect(result.scopes).toEqual(['git_bridge', 'mcp'])
    })

    it('wraps a string scope into an array', async () => {
      mockFindRecord.scopes = 'git_bridge'
      const result = await PersonalAccessTokenManager.validateToken(validToken)
      expect(result).toBeDefined()
      expect(result.scopes).toEqual(['git_bridge'])
    })

    it('works with named export validateToken', async () => {
      const result = await validateToken(validToken)
      expect(result).toBeDefined()
      expect(result.email).toBe(userEmail)
    })
  })

  describe('listTokens', () => {
    it('returns tokens for the given user excluding tokenHash sorted by createdAt descending', async () => {
      let capturedQuery
      let capturedProjection
      let capturedSort

      PersonalAccessToken.find = (query, projection) => {
        capturedQuery = query
        capturedProjection = projection
        return {
          sort: sortOptions => {
            capturedSort = sortOptions
            return {
              exec: async () => [
                {
                  _id: 'tok_1',
                  name: 'Token 1',
                  tokenPrefix: 'olp_aaaa',
                  scopes: ['git_bridge'],
                  createdAt: new Date('2026-08-22T00:00:00Z'),
                },
                {
                  _id: 'tok_2',
                  name: 'Token 2',
                  tokenPrefix: 'olp_bbbb',
                  scopes: ['git_bridge'],
                  createdAt: new Date('2026-08-21T00:00:00Z'),
                },
              ],
            }
          },
        }
      }

      const tokens = await PersonalAccessTokenManager.listTokens(userId)

      expect(capturedQuery).toEqual({ user_id: userId })
      expect(capturedProjection).toEqual({ tokenHash: 0 })
      expect(capturedSort).toEqual({ createdAt: -1 })
      expect(tokens.length).toBe(2)
      expect(tokens[0]._id).toBe('tok_1')
      expect(tokens[1]._id).toBe('tok_2')
    })

    it('works with named export listTokens', async () => {
      const tokens = await listTokens(userId)
      expect(tokens.length).toBe(2)
    })
  })

  describe('revokeToken', () => {
    it('deletes token record matching tokenId and userId', async () => {
      let capturedQuery
      const tokenId = 'pat_to_delete_456'

      PersonalAccessToken.deleteOne = async query => {
        capturedQuery = query
        return { acknowledged: true, deletedCount: 1 }
      }

      const result = await PersonalAccessTokenManager.revokeToken(
        userId,
        tokenId
      )

      expect(capturedQuery).toEqual({
        _id: tokenId,
        user_id: userId,
      })
      expect(result.deletedCount).toBe(1)
    })

    it('works with named export revokeToken', async () => {
      const tokenId = 'pat_to_delete_789'
      const result = await revokeToken(userId, tokenId)
      expect(result.deletedCount).toBe(1)
    })
  })
})
