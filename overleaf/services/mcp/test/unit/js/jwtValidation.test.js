import { expect } from 'chai'
import crypto from 'node:crypto'
import sinon from 'sinon'
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

  it('tags a network failure or unparseable JWKS as JWKS_UNAVAILABLE, not a bad token', async () => {
    const token = signTestJwt({
      sub: 'user_down',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      scope: 'mcp',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const refused = createJwtVerifier({
      jwksUrl: 'http://localhost:3000/.well-known/jwks.json',
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
    })
    const notJson = createJwtVerifier({
      jwksUrl: 'http://localhost:3000/.well-known/jwks.json',
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token <')
        },
      }),
    })
    for (const verifier of [refused, notJson]) {
      const err = await verifier.verifyToken(token).then(
        () => null,
        e => e
      )
      expect(err).to.not.be.null
      expect(err.code).to.equal('JWKS_UNAVAILABLE')
    }
  })

  it('rejects a token with no exp claim, since every access token now expires', async () => {
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    const token = signTestJwt({
      sub: 'user_forever',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      scope: 'mcp',
      grant_id: 'grant_forever',
    })

    let err
    try {
      await verifier.verifyToken(token)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/exp/)
  })

  it('rejects an exp claim that is not a number instead of skipping the expiry check', async () => {
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    const token = signTestJwt({
      sub: 'user_bad_exp',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      scope: 'mcp',
      exp: 'soon',
    })

    let err
    try {
      await verifier.verifyToken(token)
    } catch (e) {
      err = e
    }
    expect(err).to.exist
    expect(err.message).to.match(/not a number/)
  })

  it('refetches the JWKS and accepts a token when a rotated key reuses the kid', async () => {
    const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    let fetchCount = 0
    const verifier = createJwtVerifier({
      fetchJwks: async () => {
        fetchCount++
        // The first fetch holds the original key; the second holds the rotated
        // key under the same kid.
        const key = fetchCount === 1 ? jwk : rotated.publicKey.export({ format: 'jwk' })
        return { keys: [{ ...key, kid: 'test-key', alg: 'RS256', use: 'sig' }] }
      },
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    // Populate the cache with the old key first
    await verifier.verifyToken(
      signTestJwt({
        sub: 'user_before',
        iss: 'http://localhost:3000',
        aud: 'http://localhost:3050/mcp',
        scope: 'mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    )

    const token = signTestJwt(
      {
        sub: 'user_after',
        iss: 'http://localhost:3000',
        aud: 'http://localhost:3050/mcp',
        scope: 'mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      { key: rotated.privateKey }
    )
    const result = await verifier.verifyToken(token)
    expect(result.sub).to.equal('user_after')
    expect(fetchCount).to.equal(2)
  })

  describe('scope claim', () => {
    const base = () => ({
      sub: 'user_scope',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const verifier = createJwtVerifier({
      fetchJwks: async () => mockJwks,
      resourceUri: 'http://localhost:3050/mcp',
      issuer: 'http://localhost:3000',
    })

    it('refuses a token with no scope claim as insufficient_scope', async () => {
      const err = await verifier.verifyToken(signTestJwt(base())).then(
        () => null,
        e => e
      )
      expect(err).to.not.be.null
      expect(err.code).to.equal('insufficient_scope')
    })

    it('refuses a token whose scope claim is neither a string nor an array', async () => {
      const err = await verifier.verifyToken(signTestJwt({ ...base(), scope: 42 })).then(
        () => null,
        e => e
      )
      expect(err.code).to.equal('insufficient_scope')
    })

    it('accepts mcp among several space-separated scopes', async () => {
      const result = await verifier.verifyToken(
        signTestJwt({ ...base(), scope: 'read:profile  mcp write:projects' })
      )
      expect(result.sub).to.equal('user_scope')
    })

    it('accepts mcp in an array scope claim', async () => {
      const result = await verifier.verifyToken(signTestJwt({ ...base(), scope: ['mcp'] }))
      expect(result.sub).to.equal('user_scope')
    })
  })

  describe('signing key selection', () => {
    const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rotatedJwk = { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'rotated-key', alg: 'RS256', use: 'sig' }
    const claims = () => ({
      sub: 'user_kid',
      iss: 'http://localhost:3000',
      aud: 'http://localhost:3050/mcp',
      scope: 'mcp',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    it('verifies against the key named by kid when several keys are published', async () => {
      let fetchCount = 0
      const verifier = createJwtVerifier({
        fetchJwks: async () => {
          fetchCount++
          return { keys: [{ ...jwk, kid: 'old-key', alg: 'RS256', use: 'sig' }, rotatedJwk] }
        },
        resourceUri: 'http://localhost:3050/mcp',
        issuer: 'http://localhost:3000',
      })
      const token = signTestJwt(claims(), { kid: 'rotated-key', key: rotated.privateKey })
      const result = await verifier.verifyToken(token)
      expect(result.sub).to.equal('user_kid')
      expect(fetchCount).to.equal(1)
    })

    it('does not accept a signature made with the key of a different kid', async () => {
      const verifier = createJwtVerifier({
        fetchJwks: async () => ({ keys: [{ ...jwk, kid: 'old-key', alg: 'RS256', use: 'sig' }, rotatedJwk] }),
        resourceUri: 'http://localhost:3050/mcp',
        issuer: 'http://localhost:3000',
      })
      const token = signTestJwt(claims(), { kid: 'old-key', key: rotated.privateKey })
      const err = await verifier.verifyToken(token).then(
        () => null,
        e => e
      )
      expect(err.message).to.match(/signature/i)
    })

    it('refetches once for an unknown kid and accepts a key published after the cache filled', async () => {
      let fetchCount = 0
      const verifier = createJwtVerifier({
        fetchJwks: async () => {
          fetchCount++
          return fetchCount === 1 ? mockJwks : { keys: [...mockJwks.keys, rotatedJwk] }
        },
        resourceUri: 'http://localhost:3050/mcp',
        issuer: 'http://localhost:3000',
      })
      await verifier.verifyToken(signTestJwt(claims()))
      const token = signTestJwt(claims(), { kid: 'rotated-key', key: rotated.privateKey })
      const result = await verifier.verifyToken(token)
      expect(result.sub).to.equal('user_kid')
      expect(fetchCount).to.equal(2)
    })

    it('rate-limits the unknown-kid refetch to once per 30 seconds', async () => {
      const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
      try {
        let fetchCount = 0
        const verifier = createJwtVerifier({
          fetchJwks: async () => {
            fetchCount++
            return mockJwks
          },
          resourceUri: 'http://localhost:3050/mcp',
          issuer: 'http://localhost:3000',
        })
        const unknown = () => signTestJwt(claims(), { kid: 'never-published' })
        const rejection = async () =>
          verifier.verifyToken(unknown()).then(
            () => null,
            e => e
          )

        const first = await rejection()
        expect(first.message).to.match(/no matching key/i)
        expect(fetchCount).to.equal(2)

        clock.tick(10000)
        const second = await rejection()
        expect(second.message).to.match(/no matching key/i)
        expect(fetchCount).to.equal(2)

        clock.tick(21000)
        await rejection()
        expect(fetchCount).to.equal(3)
      } finally {
        clock.restore()
      }
    })

    it('shares one JWKS fetch among requests that arrive while it is in flight', async () => {
      let fetchCount = 0
      const verifier = createJwtVerifier({
        fetchJwks: async () => {
          fetchCount++
          await new Promise(resolve => setTimeout(resolve, 10))
          return mockJwks
        },
        resourceUri: 'http://localhost:3050/mcp',
        issuer: 'http://localhost:3000',
      })
      const results = await Promise.all(
        Array.from({ length: 5 }, () => verifier.verifyToken(signTestJwt(claims())))
      )
      expect(results.map(r => r.sub)).to.deep.equal(Array(5).fill('user_kid'))
      expect(fetchCount).to.equal(1)
    })

    it('does not verify RS256 with a key that is not RSA, even when the kid matches', async () => {
      // An ECDSA signature from an EC key that shares the kid must not pass as RS256.
      const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
      const ecJwk = {
        ...ec.publicKey.export({ format: 'jwk' }),
        kid: 'ec-key',
        alg: 'RS256',
        use: 'sig',
      }
      const verifier = createJwtVerifier({
        fetchJwks: async () => ({ keys: [ecJwk] }),
        resourceUri: 'http://localhost:3050/mcp',
        issuer: 'http://localhost:3000',
      })
      const token = signTestJwt(claims(), { kid: 'ec-key', key: ec.privateKey })
      const err = await verifier.verifyToken(token).then(
        () => null,
        e => e
      )
      expect(err.message).to.match(/Invalid JWT signature/)
    })
  })
})
