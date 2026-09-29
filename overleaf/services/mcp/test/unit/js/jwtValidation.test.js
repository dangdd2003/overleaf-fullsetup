import { expect } from 'chai'
import crypto from 'node:crypto'
import { createJwtVerifier } from '../../../src/oauth.js'

describe('createJwtVerifier', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  const jwk = publicKey.export({ format: 'jwk' })
  const mockJwks = {
    keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
  }

  function signTestJwt(payload, { kid = 'test-key', alg = 'RS256', key = privateKey } = {}) {
    const header = Buffer.from(
      JSON.stringify({ alg, typ: 'JWT', kid })
    ).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const input = `${header}.${body}`
    const sig = crypto.createSign('SHA256').update(input).sign(key, 'base64url')
    return `${input}.${sig}`
  }

  it('validates a correct RS256 JWT using JWKS', async () => {
    let jwksFetchCount = 0
    const verifier = createJwtVerifier({
      fetchJwks: async () => {
        jwksFetchCount++
        return mockJwks
      },
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    const token = signTestJwt({
      sub: 'user_456',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      client_id: 'claude',
      scope: 'mcp',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    const result = await verifier.verifyToken(token)
    expect(result.sub).to.equal('user_456')
    expect(result.client_id).to.equal('claude')
    expect(result.scope).to.equal('mcp')
    expect(jwksFetchCount).to.equal(1)

    // Second verification should use cached JWKS
    const result2 = await verifier.verifyToken(token)
    expect(result2.sub).to.equal('user_456')
    expect(jwksFetchCount).to.equal(1)
  })

  it('rejects an expired token', async () => {
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    const expiredToken = signTestJwt({
      sub: 'user_456',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      scope: 'mcp',
      exp: Math.floor(Date.now() / 1000) - 10,
    })

    let err
    try {
      await verifier.verifyToken(expiredToken)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/expired/i)
  })

  it('rejects a token with wrong audience', async () => {
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    const wrongAudToken = signTestJwt({
      sub: 'user_456',
      iss: 'http://localhost:3000',
      aud: 'http://wrong-audience:3050/mcp',
      scope: 'mcp',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    let err
    try {
      await verifier.verifyToken(wrongAudToken)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/audience/i)
  })

  it('accepts array audience if resourceUri is included', async () => {
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    const arrayAudToken = signTestJwt({
      sub: 'user_456',
      iss: 'http://localhost:3000',
      aud: ['http://localhost:3050/mcp', 'http://other-aud'],
      scope: 'mcp',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    const result = await verifier.verifyToken(arrayAudToken)
    expect(result.sub).to.equal('user_456')
  })

  it('rejects a token with wrong issuer', async () => {
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    const wrongIssToken = signTestJwt({
      sub: 'user_456',
      iss: 'http://evil-issuer.com',
      aud: 'http://localhost:3050/mcp',
      scope: 'mcp',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    let err
    try {
      await verifier.verifyToken(wrongIssToken)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/issuer/i)
  })

  it('rejects a token missing mcp scope', async () => {
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    const noMcpScopeToken = signTestJwt({
      sub: 'user_456',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      scope: 'read:profile write:projects',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    let err
    try {
      await verifier.verifyToken(noMcpScopeToken)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/scope/i)
  })

  it('rejects a token when nbf is in the future', async () => {
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    const futureToken = signTestJwt({
      sub: 'user_456',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      scope: 'mcp',
      nbf: Math.floor(Date.now() / 1000) + 300,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    let err
    try {
      await verifier.verifyToken(futureToken)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/active|nbf/i)
  })

  it('rejects a token with invalid signature', async () => {
    const otherKeypair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    const invalidSigToken = signTestJwt(
      {
        sub: 'user_456',
        iss: 'http://localhost:3000',
        aud: 'http://localhost:3050/mcp',
        scope: 'mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      { key: otherKeypair.privateKey }
    )

    let err
    try {
      await verifier.verifyToken(invalidSigToken)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/signature/i)
  })

  it('rejects malformed token or unsupported algorithm', async () => {
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    let err1
    try {
      await verifier.verifyToken('not-a-jwt')
    } catch (e) {
      err1 = e
    }
    expect(err1).to.exist
    expect(err1.message).to.match(/malformed/i)

    let err2
    try {
      await verifier.verifyToken('a.b')
    } catch (e) {
      err2 = e
    }
    expect(err2).to.exist
    expect(err2.message).to.match(/malformed/i)

    const noneAlgToken = signTestJwt(
      { sub: '123' },
      { alg: 'none' }
    )
    let err3
    try {
      await verifier.verifyToken(noneAlgToken)
    } catch (e) {
      err3 = e
    }
    expect(err3).to.exist
    expect(err3.message).to.match(/algorithm|RS256/i)
  })

  it('fetches JWKS via default fetch implementation if url provided', async () => {
    const fakeFetch = async url => {
      expect(url).to.equal('http://localhost:3000/.well-known/jwks.json')
      return {
        ok: true,
        json: async () => mockJwks,
      }
    }

    const verifier = createJwtVerifier({
      jwksUrl: 'http://localhost:3000/.well-known/jwks.json',
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
      fetchImpl: fakeFetch,
    })

    const token = signTestJwt({
      sub: 'user_fetch',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      scope: 'mcp',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    const result = await verifier.verifyToken(token)
    expect(result.sub).to.equal('user_fetch')
  })
})
