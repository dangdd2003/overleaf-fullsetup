import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, beforeEach, afterEach } from 'vitest'
import { expect } from 'chai'
import OAuth2KeyManager from '../../../../app/src/OAuth2/OAuth2KeyManager.mjs'

// Every access token carries an exp, so test payloads do too.
const farFutureExp = () => Math.floor(Date.now() / 1000) + 3600

describe('OAuth2KeyManager', () => {
  let tmpDir
  let keyFile

  beforeEach(() => {
    OAuth2KeyManager._clearCache()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth2-key-test-'))
    keyFile = path.join(tmpDir, 'test_key.pem')
    OAuth2KeyManager._setKeyPathForTests(keyFile)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    OAuth2KeyManager._setKeyPathForTests(null)
    OAuth2KeyManager._clearCache()
  })

  it('generates a valid RS256 keypair and produces JWKS format', async () => {
    const jwks = await OAuth2KeyManager.getJwks()
    expect(jwks).to.have.property('keys').that.is.an('array').with.lengthOf(1)
    expect(jwks.keys[0]).to.include({
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256',
    })
    expect(jwks.keys[0]).to.have.property('kid').that.is.a('string')
    expect(jwks.keys[0]).to.have.property('n').that.is.a('string')
    expect(jwks.keys[0]).to.have.property('e').that.is.a('string')
  })

  it('derives the kid from the public key so a replaced key gets a new kid', async () => {
    const firstJwks = await OAuth2KeyManager.getJwks()
    const firstKid = firstJwks.keys[0].kid
    // RFC 7638 thumbprint: base64url SHA-256, 43 characters
    expect(firstKid).to.match(/^[A-Za-z0-9_-]{43}$/)

    // A replaced key file is a replaced key.
    fs.writeFileSync(
      keyFile,
      crypto
        .generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
    )
    OAuth2KeyManager._clearCache()
    const secondJwks = await OAuth2KeyManager.getJwks()
    expect(secondJwks.keys[0].kid).to.not.equal(firstKid)
  })

  it('keeps the same kid and key across process restarts', async () => {
    const jwks1 = await OAuth2KeyManager.getJwks()

    OAuth2KeyManager._clearCache()
    const jwks2 = await OAuth2KeyManager.getJwks()

    expect(jwks2.keys[0].kid).to.equal(jwks1.keys[0].kid)
    expect(jwks2.keys[0].n).to.equal(jwks1.keys[0].n)
  })

  it('persists and loads keypair from disk at the key file path', async () => {
    const jwks1 = await OAuth2KeyManager.getJwks()
    expect(fs.existsSync(keyFile)).to.be.true
    const savedPem = fs.readFileSync(keyFile, 'utf8')
    expect(savedPem).to.include('BEGIN PRIVATE KEY')

    // Clear memory cache and re-read from disk
    OAuth2KeyManager._clearCache()
    const jwks2 = await OAuth2KeyManager.getJwks()

    expect(jwks2.keys[0].kid).to.equal(jwks1.keys[0].kid)
    expect(jwks1.keys[0].n).to.equal(jwks2.keys[0].n)
  })

  it('refuses to replace an unreadable key file, which would invalidate every token', async () => {
    const garbage = 'this is not a PEM key'
    fs.writeFileSync(keyFile, garbage)

    let err
    try {
      await OAuth2KeyManager.getJwks()
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/cannot be used/)
    expect(fs.readFileSync(keyFile, 'utf8')).to.equal(garbage)
  })

  it('fails loudly instead of running with an in-memory key that dies on restart', async () => {
    // A path whose parent is a regular file cannot be created
    const blocker = path.join(tmpDir, 'blocker')
    fs.writeFileSync(blocker, 'x')
    OAuth2KeyManager._setKeyPathForTests(path.join(blocker, 'key.pem'))

    let err
    try {
      await OAuth2KeyManager.getJwks()
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/cannot be used/)
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

  it('rejects a token with no exp claim, since every access token expires', async () => {
    const token = await OAuth2KeyManager.signJwt({ sub: 'user_123' })
    let err
    try {
      await OAuth2KeyManager.verifyJwt(token)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/exp/)
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
    expect(err.message).to.match(/not a number/)
  })
})
