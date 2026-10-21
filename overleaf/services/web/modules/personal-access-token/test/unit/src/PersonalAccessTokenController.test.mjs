import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import sinon from 'sinon'
import PersonalAccessTokenController from '../../../app/src/PersonalAccessTokenController.mjs'
import PersonalAccessTokenManager from '../../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'
import { PersonalAccessToken } from '../../../../../app/src/models/PersonalAccessToken.mjs'

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
    sinon.stub(PersonalAccessToken, 'countDocuments').resolves(0)
  })

  afterEach(() => {
    sinon.restore()
  })

  it('creates token and returns raw secret with 201, id and expiry', async () => {
    req.body.name = 'Work Laptop'
    const createdAt = new Date()
    const expiresAt = new Date(createdAt)
    expiresAt.setFullYear(expiresAt.getFullYear() + 1)
    sinon.stub(PersonalAccessTokenManager, 'createToken').resolves({
      token: 'olp_secret123',
      tokenPrefix: 'olp_secr',
      record: {
        _id: 'rec-1',
        name: 'Work Laptop',
        createdAt,
        expiresAt,
        scopes: ['git_bridge'],
      },
    })

    await PersonalAccessTokenController.createToken(req, res)
    expect(res.status.calledWith(201)).toBe(true)
    expect(
      res.json.calledWith({
        _id: 'rec-1',
        token: 'olp_secret123',
        tokenPrefix: 'olp_secr',
        name: 'Work Laptop',
        createdAt,
        expiresAt,
        scopes: ['git_bridge'],
      })
    ).toBe(true)
  })

  it('createToken refuses with 409 and revokes the new token when the user would exceed 20 active tokens', async () => {
    PersonalAccessToken.countDocuments.resolves(21)
    sinon.stub(PersonalAccessTokenManager, 'createToken').resolves({
      token: 'olp_x',
      tokenPrefix: 'olp_x',
      record: { _id: 'r', name: 'Git Token', scopes: ['git_bridge'] },
    })
    const revoke = sinon
      .stub(PersonalAccessTokenManager, 'revokeToken')
      .resolves()
    await PersonalAccessTokenController.createToken(req, res)
    expect(res.status.calledWith(409)).toBe(true)
    expect(res.json.firstCall.args[0].code).toBe('token_limit_reached')
    expect(res.json.firstCall.args[0].message).toMatch(/at most 20/)
    expect(revoke.calledWith('user-123', 'r')).toBe(true)
  })

  it('createToken counts only unexpired tokens for the cap', async () => {
    PersonalAccessToken.countDocuments.resolves(20)
    const spy = sinon.stub(PersonalAccessTokenManager, 'createToken').resolves({
      token: 'olp_x',
      tokenPrefix: 'olp_x',
      record: { _id: 'r', name: 'Git Token', scopes: ['git_bridge'] },
    })
    await PersonalAccessTokenController.createToken(req, res)
    expect(spy.calledOnce).toBe(true)
    expect(res.status.calledWith(201)).toBe(true)
    const [query] = PersonalAccessToken.countDocuments.firstCall.args
    expect(query.user_id).toBe('user-123')
    expect(query.$or).toEqual([
      { expiresAt: null },
      { expiresAt: { $gt: expect.any(Date) } },
    ])
  })

  it('createToken passes through the requested scopes', async () => {
    req.body = { name: 'AI', scopes: ['mcp'] }
    const spy = sinon
      .stub(PersonalAccessTokenManager, 'createToken')
      .resolves({
        token: 'olp_x',
        tokenPrefix: 'olp_x',
        record: { _id: 'r', name: 'AI', scopes: ['mcp'] },
      })
    await PersonalAccessTokenController.createToken(req, res)
    expect(spy.calledWith('user-123', 'AI', ['mcp'])).toBe(true)
  })

  it('createToken deduplicates scopes in req.body.scopes', async () => {
    req.body = { name: 'AI', scopes: ['mcp', 'git_bridge', 'mcp'] }
    const spy = sinon
      .stub(PersonalAccessTokenManager, 'createToken')
      .resolves({
        token: 'olp_x',
        tokenPrefix: 'olp_x',
        record: { _id: 'r', name: 'AI', scopes: ['mcp', 'git_bridge'] },
      })
    await PersonalAccessTokenController.createToken(req, res)
    expect(spy.calledWith('user-123', 'AI', ['mcp', 'git_bridge'])).toBe(true)
  })

  it('createToken coerces a bare string scope to an array', async () => {
    req.body = { name: 'AI', scopes: 'mcp' }
    const spy = sinon
      .stub(PersonalAccessTokenManager, 'createToken')
      .resolves({
        token: 'olp_x',
        tokenPrefix: 'olp_x',
        record: { _id: 'r', name: 'AI', scopes: ['mcp'] },
      })
    await PersonalAccessTokenController.createToken(req, res)
    expect(spy.calledWith('user-123', 'AI', ['mcp'])).toBe(true)
  })

  it('createToken defaults to git_bridge when scopes absent', async () => {
    req.body = { name: 'AI' }
    const spy = sinon
      .stub(PersonalAccessTokenManager, 'createToken')
      .resolves({
        token: 'olp_x',
        tokenPrefix: 'olp_x',
        record: { _id: 'r', name: 'AI', scopes: ['git_bridge'] },
      })
    await PersonalAccessTokenController.createToken(req, res)
    expect(spy.calledWith('user-123', 'AI', ['git_bridge'])).toBe(true)
  })

  it('createToken rejects an unknown scope with 400 and does not call manager', async () => {
    req.body = { name: 'x', scopes: ['root'] }
    const spy = sinon.stub(PersonalAccessTokenManager, 'createToken').resolves()
    await PersonalAccessTokenController.createToken(req, res)
    expect(res.status.calledWith(400)).toBe(true)
    expect(res.json.firstCall.args[0].code).toBe('validation_error')
    expect(spy.called).toBe(false)
  })

  it('createToken rejects a name over 100 characters or not a string, without creating a token', async () => {
    const spy = sinon.stub(PersonalAccessTokenManager, 'createToken').resolves()
    req.body = { name: 'x'.repeat(101) }
    await PersonalAccessTokenController.createToken(req, res)
    expect(res.status.calledWith(400)).toBe(true)
    req.body = { name: { $ne: 'x' } }
    await PersonalAccessTokenController.createToken(req, res)
    expect(res.status.calledWith(400)).toBe(true)
    expect(spy.called).toBe(false)
  })

  it('revokeToken answers 404 for a token id that is not an ObjectId', async () => {
    req.params.tokenId = 'not-an-id'
    const err = new Error('Cast to ObjectId failed')
    err.name = 'CastError'
    sinon.stub(PersonalAccessTokenManager, 'revokeToken').rejects(err)
    await PersonalAccessTokenController.revokeToken(req, res)
    expect(res.status.calledWith(404)).toBe(true)
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
    const [body] = res.json.firstCall.args
    expect(body.code).toBe('error')
    expect(body.message).toBe('internal error')
    expect(body.errorId).toBeDefined()
  })

  it('returns 500 when listTokens throws error', async () => {
    sinon.stub(PersonalAccessTokenManager, 'listTokens').rejects(new Error('DB failure'))
    await PersonalAccessTokenController.listTokens(req, res)
    expect(res.status.calledWith(500)).toBe(true)
    const [body] = res.json.firstCall.args
    expect(body.code).toBe('error')
    expect(body.message).toBe('internal error')
    expect(body.errorId).toBeDefined()
  })

  it('returns 500 when revokeToken throws error', async () => {
    req.params.tokenId = 'rec-1'
    sinon.stub(PersonalAccessTokenManager, 'revokeToken').rejects(new Error('DB failure'))
    await PersonalAccessTokenController.revokeToken(req, res)
    expect(res.status.calledWith(500)).toBe(true)
    const [body] = res.json.firstCall.args
    expect(body.code).toBe('error')
    expect(body.message).toBe('internal error')
    expect(body.errorId).toBeDefined()
  })
})
