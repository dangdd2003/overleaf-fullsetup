import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import OAuth2KeyManager from '../../../../../app/src/Features/OAuth2/OAuth2KeyManager.mjs'

describe('OAuth2KeyManager', () => {
  beforeEach(() => {
    OAuth2KeyManager._clearCache()
    delete process.env.MCP_OAUTH2_KEY_FILE
    delete process.env.MCP_OAUTH2_PRIVATE_KEY
  })

  it('generates a valid RS256 keypair and produces JWKS format', async () => {
    const keypair = await OAuth2KeyManager.getKeypair()
    expect(keypair).to.have.property('publicKey')
    expect(keypair).to.have.property('privateKey')
    expect(keypair).to.have.property('kid').that.is.a('string')

    const jwks = await OAuth2KeyManager.getJwks()
    expect(jwks).to.have.property('keys').that.is.an('array').with.lengthOf(1)
    expect(jwks.keys[0]).to.include({
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256',
      kid: keypair.kid,
    })
    expect(jwks.keys[0]).to.have.property('n').that.is.a('string')
    expect(jwks.keys[0]).to.have.property('e').that.is.a('string')
  })

  it('throws a clear config error instead of crashing on a malformed private key', async () => {
    process.env.MCP_OAUTH2_PRIVATE_KEY = 'not-a-valid-pem-key'
    try {
      let err
      try {
        await OAuth2KeyManager.getKeypair()
      } catch (e) {
        err = e
      }
      expect(err).to.exist
      expect(err.message).to.match(/misconfigured/i)
      expect(err.cause).to.exist
    } finally {
      delete process.env.MCP_OAUTH2_PRIVATE_KEY
    }
  })

  it('persists and loads keypair from disk when MCP_OAUTH2_KEY_FILE is specified', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth2-key-test-'))
    const keyFile = path.join(tmpDir, 'test_key.pem')
    process.env.MCP_OAUTH2_KEY_FILE = keyFile

    try {
      const keypair1 = await OAuth2KeyManager.getKeypair()
      expect(fs.existsSync(keyFile)).to.be.true
      const savedPem = fs.readFileSync(keyFile, 'utf8')
      expect(savedPem).to.include('BEGIN PRIVATE KEY')

      // Clear memory cache and re-read from disk
      OAuth2KeyManager._clearCache()
      const keypair2 = await OAuth2KeyManager.getKeypair()

      const jwks1 = await OAuth2KeyManager.getJwks()
      OAuth2KeyManager._clearCache()
      const jwks2 = await OAuth2KeyManager.getJwks()

      expect(jwks1.keys[0].n).to.equal(jwks2.keys[0].n)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      delete process.env.MCP_OAUTH2_KEY_FILE
    }
  })

  it('signs and verifies a JWT payload', async () => {
    const payload = {
      sub: 'user_123',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      scope: 'mcp',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }
    const token = await OAuth2KeyManager.signJwt(payload)
    expect(token).to.be.a('string')
    const parts = token.split('.')
    expect(parts).to.have.lengthOf(3)

    const verified = await OAuth2KeyManager.verifyJwt(token)
    expect(verified.sub).to.equal('user_123')
    expect(verified.aud).to.equal('http://localhost:3050/mcp')
    expect(verified.scope).to.equal('mcp')
  })

  it('rejects an expired or tampered JWT', async () => {
    const expiredPayload = {
      sub: 'user_123',
      exp: Math.floor(Date.now() / 1000) - 10,
    }
    const token = await OAuth2KeyManager.signJwt(expiredPayload)
    let err
    try {
      await OAuth2KeyManager.verifyJwt(token)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/expired/i)

    // Tampered signature
    const validPayload = {
      sub: 'user_123',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }
    const validToken = await OAuth2KeyManager.signJwt(validPayload)
    const [h, p, s] = validToken.split('.')
    const tamperedToken = `${h}.${p}.${s.slice(0, -4)}XXXX`
    let tamperErr
    try {
      await OAuth2KeyManager.verifyJwt(tamperedToken)
    } catch (e) {
      tamperErr = e
    }
    expect(tamperErr).to.exist
    expect(tamperErr.message).to.match(/Invalid JWT signature/i)
  })

  it('rejects token with missing exp claim', async () => {
    const payloadWithoutExp = {
      sub: 'user_123',
    }
    const token = await OAuth2KeyManager.signJwt(payloadWithoutExp)
    let err
    try {
      await OAuth2KeyManager.verifyJwt(token)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/missing or invalid/)
  })

  it('rejects token with non-numeric exp claim', async () => {
    const payloadWithInvalidExp = {
      sub: 'user_123',
      exp: 'not-a-number',
    }
    const token = await OAuth2KeyManager.signJwt(payloadWithInvalidExp)
    let err
    try {
      await OAuth2KeyManager.verifyJwt(token)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/missing or invalid/)
  })
})
