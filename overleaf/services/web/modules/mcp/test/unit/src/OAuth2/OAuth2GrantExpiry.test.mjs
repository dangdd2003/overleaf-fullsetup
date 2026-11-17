import { describe, it, expect, vi, beforeEach } from 'vitest'

const waitForDb = vi.fn(async () => undefined)
const db = {
  oauthAccessTokens: {
    createIndex: vi.fn(async () => 'ok'),
    updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
  },
  oauthApplications: {
    createIndex: vi.fn(async () => 'ok'),
  },
  oauthAuthorizationCodes: {
    createIndex: vi.fn(async () => 'ok'),
  },
}
const logger = {
  error: vi.fn(),
}

vi.mock('../../../../../../app/src/infrastructure/mongodb.mjs', () => ({
  db,
  waitForDb,
}))
vi.mock('@overleaf/logger', () => ({ default: logger }))

const {
  ensureGrantExpiry,
  GRANT_INDEXES,
  APPLICATION_INDEXES,
  AUTHORIZATION_CODE_INDEXES,
} = await import('../../../../app/src/OAuth2/OAuth2GrantExpiry.mjs')

describe('OAuth2GrantExpiry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.oauthAccessTokens.createIndex.mockResolvedValue('ok')
    db.oauthApplications.createIndex.mockResolvedValue('ok')
    db.oauthAuthorizationCodes.createIndex.mockResolvedValue('ok')
    db.oauthAccessTokens.updateMany.mockResolvedValue({ modifiedCount: 0 })
  })

  it('creates indexes on oauthAccessTokens, oauthApplications, and oauthAuthorizationCodes', async () => {
    await ensureGrantExpiry()

    expect(waitForDb).toHaveBeenCalledTimes(1)
    expect(db.oauthAccessTokens.createIndex).toHaveBeenCalledTimes(
      GRANT_INDEXES.length
    )
    expect(db.oauthApplications.createIndex).toHaveBeenCalledTimes(
      APPLICATION_INDEXES.length
    )
    expect(db.oauthApplications.createIndex).toHaveBeenCalledWith(
      { id: 1 },
      { name: 'id_1', unique: true, sparse: true }
    )
    expect(db.oauthAuthorizationCodes.createIndex).toHaveBeenCalledTimes(
      AUTHORIZATION_CODE_INDEXES.length
    )
    expect(db.oauthAuthorizationCodes.createIndex).toHaveBeenCalledWith(
      { authorizationCode: 1 },
      { name: 'authorizationCode_1', unique: true }
    )
    expect(db.oauthAuthorizationCodes.createIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      {
        name: 'expiresAt_1',
        partialFilterExpression: { expiresAt: { $exists: true } },
        expireAfterSeconds: 0,
      }
    )
    expect(db.oauthAccessTokens.updateMany).toHaveBeenCalledWith(
      {
        refreshTokenExpiresAt: { $exists: true },
        accessTokenExpiresAt: { $exists: true },
      },
      { $unset: { accessTokenExpiresAt: '' } }
    )
  })

  it('logs and continues creating remaining indexes if one createIndex fails', async () => {
    db.oauthApplications.createIndex.mockRejectedValueOnce(
      new Error('duplicate null id')
    )

    await ensureGrantExpiry()

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(db.oauthAuthorizationCodes.createIndex).toHaveBeenCalledTimes(2)
    expect(db.oauthAccessTokens.updateMany).toHaveBeenCalledTimes(1)
  })
})
