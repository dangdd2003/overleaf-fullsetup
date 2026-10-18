import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { expect } from 'chai'
import OAuth2KeyManager from '../../../../app/src/OAuth2/OAuth2KeyManager.mjs'
import OAuth2RevocationController from '../../../../app/src/OAuth2/OAuth2RevocationController.mjs'
import { OauthAccessToken } from '../../../../../../app/src/models/OauthAccessToken.mjs'

function sha256(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createMockRes() {
  return {
    statusCode: 200,
    responseData: null,
    status(s) {
      this.statusCode = s
      return this
    },
    json(data) {
      this.responseData = data
      return this
    },
  }
}

describe('OAuth2RevocationController', () => {
  let keyDir

  beforeAll(() => {
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth2-revoke-test-'))
    OAuth2KeyManager._setKeyPathForTests(path.join(keyDir, 'key.pem'))
    OAuth2KeyManager._clearCache()
  })

  afterAll(() => {
    OAuth2KeyManager._setKeyPathForTests(null)
    OAuth2KeyManager._clearCache()
    fs.rmSync(keyDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects a request without a token', async () => {
    const res = createMockRes()
    await OAuth2RevocationController.revoke({ body: {} }, res)
    expect(res.statusCode).to.equal(400)
    expect(res.responseData.error).to.equal('invalid_request')
  })

  it('revokes the grant behind a refresh token', async () => {
    const findSpy = vi.spyOn(OauthAccessToken, 'findOne')
    const deleteSpy = vi
      .spyOn(OauthAccessToken, 'deleteOne')
      .mockResolvedValue({ deletedCount: 1 })

    const res = createMockRes()
    await OAuth2RevocationController.revoke(
      { body: { token: 'oar_refresh_value', client_id: 'client_1' } },
      res
    )
    // One query: the grant is matched by its token hash
    expect(findSpy.mock.calls).to.have.lengthOf(0)
    expect(deleteSpy.mock.calls[0][0]).to.deep.equal({
      refreshToken: sha256('oar_refresh_value'),
      client_id: 'client_1',
    })
    expect(res.statusCode).to.equal(200)
  })

  it('does not revoke when client_id is missing or belongs to another client', async () => {
    vi.spyOn(OauthAccessToken, 'findOne').mockResolvedValue({ _id: 'grant_2' })
    const deleteSpy = vi.spyOn(OauthAccessToken, 'deleteOne')

    const res = createMockRes()
    await OAuth2RevocationController.revoke({ body: { token: 'oar_x' } }, res)
    expect(res.statusCode).to.equal(200)
    expect(deleteSpy.mock.calls.length).to.equal(0)
  })

  it('answers 200 for an unknown refresh token without deleting anything', async () => {
    const deleteSpy = vi
      .spyOn(OauthAccessToken, 'deleteOne')
      .mockResolvedValue({ deletedCount: 0 })

    const res = createMockRes()
    await OAuth2RevocationController.revoke(
      { body: { token: 'oar_unknown', client_id: 'client_1' } },
      res
    )
    expect(deleteSpy.mock.calls[0][0]).to.deep.equal({
      refreshToken: sha256('oar_unknown'),
      client_id: 'client_1',
    })
    expect(res.statusCode).to.equal(200)
    expect(res.responseData).to.deep.equal({})
  })

  it('revokes the grant named by a valid access token', async () => {
    const deleteSpy = vi
      .spyOn(OauthAccessToken, 'deleteOne')
      .mockResolvedValue({ deletedCount: 1 })
    const token = await OAuth2KeyManager.signJwt({
      sub: 'user_revoke_1',
      grant_id: '65f0c0ffee0000000000abcd',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    const res = createMockRes()
    await OAuth2RevocationController.revoke(
      { body: { token, client_id: 'client_1' } },
      res
    )
    expect(deleteSpy.mock.calls[0][0]).to.deep.equal({
      _id: '65f0c0ffee0000000000abcd',
      client_id: 'client_1',
    })
    expect(res.statusCode).to.equal(200)
  })

  it('does not trust the grant_id of a forged access token', async () => {
    const deleteSpy = vi
      .spyOn(OauthAccessToken, 'deleteOne')
      .mockResolvedValue({ deletedCount: 1 })
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const payload = Buffer.from(
      JSON.stringify({ sub: 'attacker', grant_id: 'victim_grant' })
    ).toString('base64url')
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT' })
    ).toString('base64url')
    const signature = crypto
      .createSign('SHA256')
      .update(`${header}.${payload}`)
      .sign(privateKey, 'base64url')

    const res = createMockRes()
    await OAuth2RevocationController.revoke(
      { body: { token: `${header}.${payload}.${signature}` } },
      res
    )
    expect(deleteSpy.mock.calls.length).to.equal(0)
    expect(res.statusCode).to.equal(200)
  })

  it('does not resolve an expired access token; the refresh token revokes instead', async () => {
    const deleteSpy = vi
      .spyOn(OauthAccessToken, 'deleteOne')
      .mockResolvedValue({ deletedCount: 1 })
    const token = await OAuth2KeyManager.signJwt({
      sub: 'user_revoke_2',
      grant_id: '65f0c0ffee0000000000abce',
      exp: Math.floor(Date.now() / 1000) - 10,
    })

    const res = createMockRes()
    await OAuth2RevocationController.revoke({ body: { token } }, res)
    expect(deleteSpy.mock.calls.length).to.equal(0)
    expect(res.statusCode).to.equal(200)
  })
})
