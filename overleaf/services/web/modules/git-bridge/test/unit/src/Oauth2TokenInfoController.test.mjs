import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import sinon from 'sinon'
import Oauth2TokenInfoController from '../../../app/src/Oauth2TokenInfoController.mjs'
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

  it('rejects a token that does not carry the git_bridge scope', async () => {
    req.headers.authorization = 'Bearer olp_mcponlytoken'
    sinon.stub(PersonalAccessTokenManager, 'validateToken').resolves({
      userId: 'user-123',
      email: 'test@example.com',
      scopes: ['mcp'],
    })

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(res.status.calledWith(401)).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({ error: 'invalid_token' })
  })

  it('rejects a token with no scopes', async () => {
    req.headers.authorization = 'Bearer olp_noscopes'
    sinon.stub(PersonalAccessTokenManager, 'validateToken').resolves({
      userId: 'user-123',
      email: 'test@example.com',
    })

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(res.status.calledWith(401)).toBe(true)
  })

  it('prefers the Authorization header over the access_token query parameter', async () => {
    req.headers.authorization = 'Bearer olp_fromheader'
    req.query = { access_token: 'olp_fromquery' }
    const validate = sinon.stub(PersonalAccessTokenManager, 'validateToken').resolves({
      userId: 'user-123',
      email: 'test@example.com',
      scopes: ['git_bridge'],
    })

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(validate.calledWith('olp_fromheader')).toBe(true)
    expect(validate.calledWith('olp_fromquery')).toBe(false)
  })

  it('falls back to the access_token query parameter and redacts it', async () => {
    req.url = '/oauth/token/info?access_token=olp_fromquery'
    req.originalUrl = req.url
    req.query = { access_token: 'olp_fromquery' }
    const validate = sinon.stub(PersonalAccessTokenManager, 'validateToken').resolves({
      userId: 'user-123',
      email: 'test@example.com',
      scopes: ['git_bridge'],
    })

    await Oauth2TokenInfoController.getTokenInfo(req, res)
    expect(validate.calledWith('olp_fromquery')).toBe(true)
    expect(req.originalUrl).not.toContain('olp_fromquery')
    expect(req.query.access_token).not.toContain('olp_fromquery')
  })
})
