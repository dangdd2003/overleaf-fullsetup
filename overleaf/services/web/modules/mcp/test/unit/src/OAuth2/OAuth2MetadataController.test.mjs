import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { expect } from 'chai'
import Settings from '@overleaf/settings'
import OAuth2MetadataController from '../../../../app/src/OAuth2/OAuth2MetadataController.mjs'
import OAuth2KeyManager from '../../../../app/src/OAuth2/OAuth2KeyManager.mjs'

describe('OAuth2MetadataController', () => {
  let originalSiteUrl
  let keyDir

  beforeAll(() => {
    // The JWKS test reads the real key; keep it out of the default path.
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth2-metadata-test-'))
    OAuth2KeyManager._setKeyPathForTests(path.join(keyDir, 'key.pem'))
    OAuth2KeyManager._clearCache()
  })

  afterAll(() => {
    OAuth2KeyManager._setKeyPathForTests(null)
    OAuth2KeyManager._clearCache()
    fs.rmSync(keyDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    originalSiteUrl = Settings.siteUrl
    Settings.siteUrl = 'http://localhost:3000'
  })

  afterEach(() => {
    Settings.siteUrl = originalSiteUrl
  })

  it('returns RFC 8414 Authorization Server Metadata', async () => {
    let responseData = null
    const req = {
      protocol: 'http',
      get: header => (header === 'host' ? 'localhost:3000' : ''),
    }
    const res = {
      json: data => {
        responseData = data
      },
    }
    await OAuth2MetadataController.getAuthorizationServerMetadata(req, res)
    expect(responseData).to.include({
      issuer: 'http://localhost:3000',
      authorization_endpoint: 'http://localhost:3000/oauth/authorize',
      token_endpoint: 'http://localhost:3000/oauth/token',
      jwks_uri: 'http://localhost:3000/.well-known/jwks.json',
      registration_endpoint: 'http://localhost:3000/oauth/register',
      revocation_endpoint: 'http://localhost:3000/oauth/revoke',
      authorization_response_iss_parameter_supported: true,
    })
    expect(responseData.code_challenge_methods_supported).to.deep.equal([
      'S256',
    ])
    expect(responseData.scopes_supported).to.deep.equal(['mcp', 'offline_access'])
    expect(responseData.token_endpoint_auth_methods_supported).to.deep.equal([
      'none',
    ])
  })

  it('falls back to req host when Settings.siteUrl is unset', async () => {
    Settings.siteUrl = ''
    let responseData = null
    const req = {
      protocol: 'http',
      get: header => (header === 'host' ? 'auth.example.com' : ''),
    }
    const res = {
      json: data => {
        responseData = data
      },
    }
    await OAuth2MetadataController.getAuthorizationServerMetadata(req, res)
    expect(responseData.issuer).to.equal('http://auth.example.com')
    expect(responseData.authorization_endpoint).to.equal(
      'http://auth.example.com/oauth/authorize'
    )
  })

  it('returns OIDC configuration identical to auth server metadata', async () => {
    let responseData = null
    const req = {
      protocol: 'http',
      get: header => (header === 'host' ? 'localhost:3000' : ''),
    }
    const res = {
      json: data => {
        responseData = data
      },
    }
    await OAuth2MetadataController.getOpenIdConfiguration(req, res)
    expect(responseData).to.include({
      issuer: 'http://localhost:3000',
      authorization_endpoint: 'http://localhost:3000/oauth/authorize',
    })
  })

  it('returns JWKS JSON', async () => {
    let responseData = null
    let headerSet = null
    const res = {
      setHeader: (name, val) => {
        headerSet = { name, val }
      },
      json: data => {
        responseData = data
      },
    }
    await OAuth2MetadataController.getJwks({}, res)
    expect(headerSet).to.deep.equal({
      name: 'Cache-Control',
      val: 'public, max-age=86400',
    })
    expect(responseData).to.have.property('keys').that.is.an('array')
    expect(responseData.keys[0].alg).to.equal('RS256')
  })
})
