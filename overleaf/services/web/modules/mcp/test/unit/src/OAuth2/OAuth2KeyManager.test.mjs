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
    delete process.env.MCP_OAUTH2_PRIVATE_KEY
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth2-key-test-'))
    keyFile = path.join(tmpDir, 'test_key.pem')
    process.env.MCP_OAUTH2_KEY_FILE = keyFile
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.MCP_OAUTH2_KEY_FILE
    delete process.env.MCP_OAUTH2_PRIVATE_KEY
    OAuth2KeyManager._clearCache()
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

  it('derives the kid from the public key so a replaced key gets a new kid', async () => {
    const first = await OAuth2KeyManager.getKeypair()
    // RFC 7638 thumbprint: base64url SHA-256, 43 characters
    expect(first.kid).to.match(/^[A-Za-z0-9_-]{43}$/)

    process.env.MCP_OAUTH2_PRIVATE_KEY = crypto
      .generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
    OAuth2KeyManager._clearCache()
    const second = await OAuth2KeyManager.getKeypair()
    expect(second.kid).to.not.equal(first.kid)
  })

  it('keeps the same kid and key across process restarts', async () => {
    const first = await OAuth2KeyManager.getKeypair()
    const jwks1 = await OAuth2KeyManager.getJwks()

    OAuth2KeyManager._clearCache()
    const second = await OAuth2KeyManager.getKeypair()
    const jwks2 = await OAuth2KeyManager.getJwks()

    expect(second.kid).to.equal(first.kid)
    expect(jwks2.keys[0].n).to.equal(jwks1.keys[0].n)
  })

  it('throws a clear config error instead of crashing on a malformed private key', async () => {
    process.env.MCP_OAUTH2_PRIVATE_KEY = 'not-a-valid-pem-key'
    let err
    try {
      await OAuth2KeyManager.getKeypair()
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/misconfigured/i)
    expect(err.cause).to.exist
  })

  it('persists and loads keypair from disk when MCP_OAUTH2_KEY_FILE is specified', async () => {
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

    expect(keypair2.kid).to.equal(keypair1.kid)
    expect(jwks1.keys[0].n).to.equal(jwks2.keys[0].n)
  })

  it('refuses to replace an unreadable key file, which would invalidate every token', async () => {
    const garbage = 'this is not a PEM key'
    fs.writeFileSync(keyFile, garbage)

    let err
    try {
      await OAuth2KeyManager.getKeypair()
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
    process.env.MCP_OAUTH2_KEY_FILE = path.join(blocker, 'key.pem')

    let err
    try {
      await OAuth2KeyManager.getKeypair()
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

  describe('key rotation', () => {
    function keyringPath() {
      return path.join(path.dirname(keyFile), 'oauth2_keyring.json')
    }

    // Sign a token with a key that is not in this process's key set, as a
    // different process would after rotating.
    function signWithForeignKey(privateKey, kid, payload) {
      const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url')
      const input = `${enc({ alg: 'RS256', typ: 'JWT', kid })}.${enc(payload)}`
      const signature = crypto
        .createSign('SHA256')
        .update(input)
        .end()
        .sign(privateKey)
        .toString('base64url')
      return `${input}.${signature}`
    }

    async function publishedKids() {
      const jwks = await OAuth2KeyManager.getJwks()
      return jwks.keys.map(key => key.kid)
    }

    it('publishes only the primary key when no key has been rotated in', async () => {
      const primary = await OAuth2KeyManager.getKeypair()
      expect(await publishedKids()).to.deep.equal([primary.kid])
      expect(fs.existsSync(keyringPath())).to.be.false
    })

    it('signs with the new key after rotation and keeps the old key verifiable', async () => {
      const before = await OAuth2KeyManager.getKeypair()
      const oldToken = await OAuth2KeyManager.signJwt({ sub: 'user_old', exp: farFutureExp() })

      const { kid } = await OAuth2KeyManager.rotateSigningKey()
      expect(kid).to.not.equal(before.kid)
      expect(await publishedKids()).to.have.members([before.kid, kid])

      const newToken = await OAuth2KeyManager.signJwt({ sub: 'user_new', exp: farFutureExp() })
      const header = JSON.parse(
        Buffer.from(newToken.split('.')[0], 'base64url').toString()
      )
      expect(header.kid).to.equal(kid)

      expect((await OAuth2KeyManager.verifyJwt(oldToken)).sub).to.equal('user_old')
      expect((await OAuth2KeyManager.verifyJwt(newToken)).sub).to.equal('user_new')
    })

    it('keeps rotated keys across a restart', async () => {
      const before = await OAuth2KeyManager.getKeypair()
      const oldToken = await OAuth2KeyManager.signJwt({ sub: 'user_old', exp: farFutureExp() })
      const { kid } = await OAuth2KeyManager.rotateSigningKey()
      const newToken = await OAuth2KeyManager.signJwt({ sub: 'user_new', exp: farFutureExp() })

      OAuth2KeyManager._clearCache()
      expect(await publishedKids()).to.have.members([before.kid, kid])
      expect((await OAuth2KeyManager.verifyJwt(oldToken)).sub).to.equal('user_old')
      expect((await OAuth2KeyManager.verifyJwt(newToken)).sub).to.equal('user_new')
      expect((await OAuth2KeyManager.getKeypair()).kid).to.equal(kid)
    })

    it('reloads the keyring when a token names a kid this process has not loaded', async () => {
      await OAuth2KeyManager.getJwks()
      // Another process rotates while this one holds a stale key set
      const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
      const foreignKid = 'foreign-kid'
      fs.writeFileSync(
        keyringPath(),
        JSON.stringify({
          keys: [
            {
              kid: foreignKid,
              createdAt: new Date().toISOString(),
              privateKey: foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }),
            },
          ],
          retiredKids: [],
        })
      )
      const token = signWithForeignKey(foreign.privateKey, foreignKid, {
        sub: 'user_foreign',
        exp: farFutureExp(),
      })

      expect((await OAuth2KeyManager.verifyJwt(token)).sub).to.equal('user_foreign')
    })

    it('refuses a token whose kid was never published', async () => {
      const token = signWithForeignKey(
        crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
        'unknown-kid',
        { sub: 'user_x', exp: farFutureExp() }
      )
      let err
      try {
        await OAuth2KeyManager.verifyJwt(token)
      } catch (e) {
        err = e
      }
      expect(err.message).to.equal('Unknown JWT kid')
    })

    it('retires an old key: it leaves the JWKS and its tokens stop verifying', async () => {
      const before = await OAuth2KeyManager.getKeypair()
      const oldToken = await OAuth2KeyManager.signJwt({ sub: 'user_old', exp: farFutureExp() })
      const { kid } = await OAuth2KeyManager.rotateSigningKey()

      await OAuth2KeyManager.retireSigningKey(before.kid)
      expect(await publishedKids()).to.deep.equal([kid])

      let err
      try {
        await OAuth2KeyManager.verifyJwt(oldToken)
      } catch (e) {
        err = e
      }
      expect(err.message).to.equal('Unknown JWT kid')
    })

    it('keeps a retired key retired after a restart', async () => {
      const before = await OAuth2KeyManager.getKeypair()
      const { kid } = await OAuth2KeyManager.rotateSigningKey()
      await OAuth2KeyManager.retireSigningKey(before.kid)

      OAuth2KeyManager._clearCache()
      expect(await publishedKids()).to.deep.equal([kid])
    })

    it('refuses to retire the key that is currently signing', async () => {
      await OAuth2KeyManager.rotateSigningKey()
      const signer = await OAuth2KeyManager.getKeypair()
      let err
      try {
        await OAuth2KeyManager.retireSigningKey(signer.kid)
      } catch (e) {
        err = e
      }
      expect(err.message).to.match(/active signing key/)
      expect(await publishedKids()).to.include(signer.kid)
    })

    it('rejects retiring a kid that is not published', async () => {
      let err
      try {
        await OAuth2KeyManager.retireSigningKey('no-such-kid')
      } catch (e) {
        err = e
      }
      expect(err.message).to.match(/not an active key/)
    })

    it('stops with an error on a corrupt keyring instead of treating it as empty', async () => {
      fs.writeFileSync(keyringPath(), '{not json')
      let err
      try {
        await OAuth2KeyManager.getJwks()
      } catch (e) {
        err = e
      }
      expect(err.message).to.match(/not valid JSON/)
      let rotateErr
      try {
        await OAuth2KeyManager.rotateSigningKey()
      } catch (e) {
        rotateErr = e
      }
      expect(rotateErr.message).to.match(/not valid JSON/)
      // The corrupt file is left in place for the operator to inspect
      expect(fs.readFileSync(keyringPath(), 'utf8')).to.equal('{not json')
    })
  })

  describe('keyring lock', () => {
    function keyringPath() {
      return path.join(path.dirname(keyFile), 'oauth2_keyring.json')
    }
    function lockPath() {
      return `${keyringPath()}.lock`
    }

    it('waits for a lock another process holds, then rotates', async () => {
      fs.writeFileSync(lockPath(), '4242')
      setTimeout(() => fs.rmSync(lockPath(), { force: true }), 100)

      const { kid } = await OAuth2KeyManager.rotateSigningKey()

      const stored = JSON.parse(fs.readFileSync(keyringPath(), 'utf8'))
      expect(stored.keys.map(entry => entry.kid)).to.include(kid)
      expect(fs.existsSync(lockPath())).to.be.false
    })

    it('removes a stale lock left by a process that died holding it', async () => {
      fs.writeFileSync(lockPath(), '4242')
      const old = new Date(Date.now() - 60 * 60 * 1000)
      fs.utimesSync(lockPath(), old, old)

      const { kid } = await OAuth2KeyManager.rotateSigningKey()

      const stored = JSON.parse(fs.readFileSync(keyringPath(), 'utf8'))
      expect(stored.keys.map(entry => entry.kid)).to.include(kid)
      expect(fs.existsSync(lockPath())).to.be.false
    })

    it('re-reads the keyring after taking the lock, so a rotation made meanwhile is kept', async () => {
      // Another process holds the lock, rotates, and releases it. This process
      // must build on what that process wrote, not on the file it read first.
      fs.writeFileSync(lockPath(), '4242')
      const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
      setTimeout(() => {
        fs.writeFileSync(
          keyringPath(),
          JSON.stringify({
            keys: [
              {
                kid: 'foreign-kid',
                createdAt: new Date().toISOString(),
                privateKey: foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }),
              },
            ],
            retiredKids: [],
          })
        )
        fs.rmSync(lockPath(), { force: true })
      }, 100)

      const { kid } = await OAuth2KeyManager.rotateSigningKey()

      const stored = JSON.parse(fs.readFileSync(keyringPath(), 'utf8'))
      const kids = stored.keys.map(entry => entry.kid)
      expect(kids).to.include('foreign-kid')
      expect(kids).to.include(kid)
    })

    it('releases the lock when the change fails, so the next caller is not blocked', async () => {
      let err
      try {
        await OAuth2KeyManager.retireSigningKey('not-a-kid')
      } catch (e) {
        err = e
      }
      expect(err.message).to.match(/not an active key/)
      expect(fs.existsSync(lockPath())).to.be.false
      await OAuth2KeyManager.rotateSigningKey()
    })
  })
});
