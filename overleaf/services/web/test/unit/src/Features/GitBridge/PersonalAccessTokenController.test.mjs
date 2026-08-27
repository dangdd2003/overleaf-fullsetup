import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import sinon from 'sinon'
import PersonalAccessTokenController from '../../../../../app/src/Features/GitBridge/PersonalAccessTokenController.mjs'
import PersonalAccessTokenManager from '../../../../../app/src/Features/GitBridge/PersonalAccessTokenManager.mjs'

describe('PersonalAccessTokenController', () => {
  let req, res

  beforeEach(() => {
    req = {
      session: { user: { _id: 'user-123' } },
      body: {},
      params: {},
    }
    res = {
      json: sinon.stub(),
      sendStatus: sinon.stub(),
      status: sinon.stub().returnsThis(),
    }
  })

  afterEach(() => {
    sinon.restore()
  })

  it('creates token and returns raw secret', async () => {
    req.body.name = 'Work Laptop'
    const createdAt = new Date()
    sinon.stub(PersonalAccessTokenManager, 'createToken').resolves({
      token: 'olp_secret123',
      tokenPrefix: 'olp_secr',
      record: { _id: 'rec-1', name: 'Work Laptop', createdAt },
    })

    await PersonalAccessTokenController.createToken(req, res)
    expect(
      res.json.calledWith({
        token: 'olp_secret123',
        tokenPrefix: 'olp_secr',
        name: 'Work Laptop',
        createdAt,
      })
    ).toBe(true)
  })

  it('lists tokens for user', async () => {
    sinon.stub(PersonalAccessTokenManager, 'listTokens').resolves([
      { _id: 'rec-1', name: 'Work Laptop', tokenPrefix: 'olp_secr' },
    ])

    await PersonalAccessTokenController.listTokens(req, res)
    expect(
      res.json.calledWith([
        { _id: 'rec-1', name: 'Work Laptop', tokenPrefix: 'olp_secr' },
      ])
    ).toBe(true)
  })

  it('revokes token', async () => {
    req.params.tokenId = 'rec-1'
    sinon.stub(PersonalAccessTokenManager, 'revokeToken').resolves(true)

    await PersonalAccessTokenController.revokeToken(req, res)
    expect(res.sendStatus.calledWith(204)).toBe(true)
  })

  it('returns 500 when createToken throws error', async () => {
    sinon.stub(PersonalAccessTokenManager, 'createToken').rejects(new Error('DB failure'))
    await PersonalAccessTokenController.createToken(req, res)
    expect(res.status.calledWith(500)).toBe(true)
    expect(res.json.calledWith({ code: 'error', message: 'DB failure' })).toBe(true)
  })

  it('returns 500 when listTokens throws error', async () => {
    sinon.stub(PersonalAccessTokenManager, 'listTokens').rejects(new Error('DB failure'))
    await PersonalAccessTokenController.listTokens(req, res)
    expect(res.status.calledWith(500)).toBe(true)
    expect(res.json.calledWith({ code: 'error', message: 'DB failure' })).toBe(true)
  })

  it('returns 500 when revokeToken throws error', async () => {
    req.params.tokenId = 'rec-1'
    sinon.stub(PersonalAccessTokenManager, 'revokeToken').rejects(new Error('DB failure'))
    await PersonalAccessTokenController.revokeToken(req, res)
    expect(res.status.calledWith(500)).toBe(true)
    expect(res.json.calledWith({ code: 'error', message: 'DB failure' })).toBe(true)
  })
})
