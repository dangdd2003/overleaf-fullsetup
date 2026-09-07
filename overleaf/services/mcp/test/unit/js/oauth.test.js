import crypto from 'node:crypto'
import { expect } from 'chai'
import {
  getProtectedResourceMetadata,
  buildProtectedResourceMetadataUrl,
  buildWwwAuthenticateHeader,
  createJwtVerifier,
} from '../../../src/oauth.js'

describe('MCP OAuth Protected Resource', () => {
  const config = {
    resourceUri: 'http://localhost:3050/mcp',
    authServerUrl: 'http://localhost:3000',
  }

  it('returns RFC 9728 metadata', () => {
    const meta = getProtectedResourceMetadata(config)
    expect(meta).to.deep.equal({
      resource: 'http://localhost:3050/mcp',
      authorization_servers: ['http://localhost:3000'],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      resource_documentation: 'http://localhost:3000/help',
    })
  })

  // RFC 9728 §3.1: when the resource identifier has a path component, the
  // well-known suffix is inserted between the host and that path. Appending it
  // to the path instead is the OIDC convention and is not a valid form here.
  describe('buildProtectedResourceMetadataUrl', () => {
    it('inserts the well-known suffix before the resource path', () => {
      expect(
        buildProtectedResourceMetadataUrl('https://example.com/mcp')
      ).to.equal('https://example.com/.well-known/oauth-protected-resource/mcp')
    })

    it('preserves nested resource paths', () => {
      expect(
        buildProtectedResourceMetadataUrl('https://example.com/a/b')
      ).to.equal('https://example.com/.well-known/oauth-protected-resource/a/b')
    })

    it('drops a terminating slash before inserting the suffix', () => {
      expect(
        buildProtectedResourceMetadataUrl('https://example.com/mcp/')
      ).to.equal('https://example.com/.well-known/oauth-protected-resource/mcp')
    })

    it('omits the path segment for a root resource', () => {
      expect(buildProtectedResourceMetadataUrl('https://example.com/')).to.equal(
        'https://example.com/.well-known/oauth-protected-resource'
      )
      expect(buildProtectedResourceMetadataUrl('https://example.com')).to.equal(
        'https://example.com/.well-known/oauth-protected-resource'
      )
    })
  })

  it('builds WWW-Authenticate challenge header pointing at the RFC 9728 URL', () => {
    const header = buildWwwAuthenticateHeader(config)
    expect(header).to.equal(
      'Bearer resource_metadata="http://localhost:3050/.well-known/oauth-protected-resource/mcp", scope="mcp"'
    )
  })

  it('builds WWW-Authenticate challenge with error details', () => {
    const header = buildWwwAuthenticateHeader(
      config,
      'invalid_token',
      'The token has expired'
    )
    expect(header).to.include('error="invalid_token"')
    expect(header).to.include('error_description="The token has expired"')
  })

  describe('createJwtVerifier kid resolution and cache refresh', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    const jwk = publicKey.export({ format: 'jwk' })

    function createTestJwt({ kid = 'key-1', payload = {} } = {}) {
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })
      ).toString('base64url')
      const body = Buffer.from(
        JSON.stringify({
          sub: 'user_123',
          iss: 'http://localhost:3000',
          aud: 'http://localhost:3050/mcp',
          scope: 'mcp',
          exp: Math.floor(Date.now() / 1000) + 3600,
          ...payload,
        })
      ).toString('base64url')
      const input = `${header}.${body}`
      const sig = crypto
        .createSign('SHA256')
        .update(input)
        .sign(privateKey, 'base64url')
      return `${input}.${sig}`
    }

    it('throws when header.kid does not exist even after JWKS refresh', async () => {
      let fetchCount = 0
      const verifier = createJwtVerifier({
        fetchJwks: async () => {
          fetchCount++
          return {
            keys: [{ ...jwk, kid: 'key-1', kty: 'RSA', alg: 'RS256' }],
          }
        },
      })

      const fakeJwt = createTestJwt({ kid: 'key-unknown' })
      let err
      try {
        await verifier.verifyToken(fakeJwt)
      } catch (e) {
        err = e
      }
      expect(err).to.exist
      expect(err.message).to.equal(
        'No matching key found in JWKS for kid "key-unknown"'
      )
      // First fetch to populate initial cache, second fetch after kid mismatch cache miss
      expect(fetchCount).to.equal(2)
    })

    it('refreshes JWKS cache when new kid is introduced (key rotation) and succeeds', async () => {
      let fetchCount = 0
      const verifier = createJwtVerifier({
        fetchJwks: async () => {
          fetchCount++
          if (fetchCount === 1) {
            return {
              keys: [{ kid: 'old-key', kty: 'RSA', alg: 'RS256' }],
            }
          }
          return {
            keys: [
              { kid: 'old-key', kty: 'RSA', alg: 'RS256' },
              { ...jwk, kid: 'rotated-key', kty: 'RSA', alg: 'RS256' },
            ],
          }
        },
      })

      const rotatedJwt = createTestJwt({ kid: 'rotated-key' })
      const result = await verifier.verifyToken(rotatedJwt)
      expect(result.sub).to.equal('user_123')
      expect(fetchCount).to.equal(2)
    })
  })
})
