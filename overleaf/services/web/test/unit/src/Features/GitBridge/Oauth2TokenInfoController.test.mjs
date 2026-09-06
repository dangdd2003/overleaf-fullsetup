import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import sinon from 'sinon'
import Oauth2TokenInfoController from '../../../../../app/src/Features/GitBridge/Oauth2TokenInfoController.mjs'
import PersonalAccessTokenManager from '../../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'

describe('Oauth2TokenInfoController', () => {
  let req, res

  beforeEach(() => {
    req = { headers: {} }
    res = {
      json: sinon.stub(),
      status: sinon.stub().returnsThis(),
    }
  })

  afterEach(() => {
    sinon.restore()
  })

  it('authenticates Bearer token header and returns token info', async () => {
    req.headers.authorization = 'Bearer olp_validtoken123'
    sinon.stub(PersonalAccessTokenManager, 'validateToken').resolves({
      userId: 'user-123',
      email: 'test@example.com',
      scopes: ['git_bridge'],
    })

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(
      res.json.calledWith({
        userId: 'user-123',
        email: 'test@example.com',
        scopes: ['git_bridge'],
      })
    ).toBe(true)
  })

  it('authenticates Basic git:<token> header and returns token info', async () => {
    req.headers.authorization = `Basic ${Buffer.from('git:olp_validtoken123').toString('base64')}`
    sinon.stub(PersonalAccessTokenManager, 'validateToken').resolves({
      userId: 'user-123',
      email: 'test@example.com',
      scopes: ['git_bridge'],
    })

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(
      res.json.calledWith({
        userId: 'user-123',
        email: 'test@example.com',
        scopes: ['git_bridge'],
      })
    ).toBe(true)
  })

  it('returns 401 when authorization header is missing', async () => {
    req.headers.authorization = ''

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(res.status.calledWith(401)).toBe(true)
    expect(
      res.json.calledWith({
        error: 'invalid_token',
        error_description: 'Authorization header is missing or malformed.',
      })
    ).toBe(true)
  })

  it('returns 401 when token is invalid or expired', async () => {
    req.headers.authorization = 'Bearer olp_badtoken'
    sinon.stub(PersonalAccessTokenManager, 'validateToken').resolves(null)

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(res.status.calledWith(401)).toBe(true)
    expect(
      res.json.calledWith({
        error: 'invalid_token',
        error_description: 'The access token provided is invalid or expired.',
      })
    ).toBe(true)
  })
})
