import { describe, it, beforeEach } from 'vitest'
import { expect } from 'chai'
import OAuth2PreconfiguredClients from '../../../../../app/src/Features/OAuth2/OAuth2PreconfiguredClients.mjs'
import Settings from '@overleaf/settings'

describe('OAuth2PreconfiguredClients', () => {
  beforeEach(() => {
    Settings.siteUrl = 'https://sharelatex.test.overleaf.com'
    delete process.env.PUBLIC_URL
    delete process.env.OVERLEAF_URL
    delete process.env.SITE_URL
    delete process.env.OVERLEAF_OAUTH_ALLOWED_REDIRECT_URIS
    delete process.env.OVERLEAF_OAUTH_REDIRECT_URIS
  })

  describe('getClient', () => {
    it('returns client config for known clients', () => {
      const claude = OAuth2PreconfiguredClients.getClient('claude')
      expect(claude).to.not.be.null
      expect(claude.id).to.equal('claude')
      expect(claude.isPublic).to.be.true
    })

    it('returns null for unknown client id', () => {
      expect(OAuth2PreconfiguredClients.getClient('unknown-client')).to.be.null
    })
  })

  describe('isRedirectUriAllowed', () => {
    it('rejects invalid inputs or non-string URIs', () => {
      const client = OAuth2PreconfiguredClients.getClient('claude')
      expect(OAuth2PreconfiguredClients.isRedirectUriAllowed(null, 'http://localhost:8080')).to.be.false
      expect(OAuth2PreconfiguredClients.isRedirectUriAllowed(client, null)).to.be.false
      expect(OAuth2PreconfiguredClients.isRedirectUriAllowed(client, 123)).to.be.false
      expect(OAuth2PreconfiguredClients.isRedirectUriAllowed(client, 'invalid-url')).to.be.false
    })

    it('rejects URIs with userinfo (@)', () => {
      const client = OAuth2PreconfiguredClients.getClient('claude')
      expect(
        OAuth2PreconfiguredClients.isRedirectUriAllowed(
          client,
          'http://user:pass@localhost:8080/callback'
        )
      ).to.be.false
    })

    it('allows loopback redirects for native clients', () => {
      const client = OAuth2PreconfiguredClients.getClient('claude')
      expect(OAuth2PreconfiguredClients.isRedirectUriAllowed(client, 'http://localhost:8080/callback')).to.be.true
      expect(OAuth2PreconfiguredClients.isRedirectUriAllowed(client, 'http://localhost:3000/callback')).to.be.true
      expect(OAuth2PreconfiguredClients.isRedirectUriAllowed(client, 'http://127.0.0.1:4567/callback')).to.be.true
    })

    it('permits official integration callbacks on siteUrl', () => {
      const client = OAuth2PreconfiguredClients.getClient('claude')
      const allowedMcp = OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'https://sharelatex.test.overleaf.com/user/mcp/callback'
      )
      const allowedOauth = OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'https://sharelatex.test.overleaf.com/oauth/callback'
      )
      expect(allowedMcp).to.be.true
      expect(allowedOauth).to.be.true
    })

    it('rejects arbitrary subpaths on siteUrl', () => {
      const client = OAuth2PreconfiguredClients.getClient('claude')
      const allowed = OAuth2PreconfiguredClients.isRedirectUriAllowed(
        client,
        'https://sharelatex.test.overleaf.com/project/64a1234567890abcdef12345'
      )
      expect(allowed).to.be.false
    })
  })
})
