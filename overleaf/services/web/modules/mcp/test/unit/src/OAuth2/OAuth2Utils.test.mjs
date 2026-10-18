import crypto from 'node:crypto'
import { describe, it } from 'vitest'
import { expect } from 'chai'
import Settings from '@overleaf/settings'
import {
  base64url,
  getBaseUrl,
  hashToken,
  normalizeScope,
} from '../../../../app/src/OAuth2/OAuth2Utils.mjs'

describe('OAuth2Utils', () => {
  describe('normalizeScope', () => {
    it('defaults a missing or blank scope to mcp', () => {
      expect(normalizeScope(undefined)).to.equal('mcp')
      expect(normalizeScope(null)).to.equal('mcp')
      expect(normalizeScope('')).to.equal('mcp')
      expect(normalizeScope('   ')).to.equal('mcp')
    })

    it('accepts mcp, including repeated and padded forms', () => {
      expect(normalizeScope('mcp')).to.equal('mcp')
      expect(normalizeScope('  mcp ')).to.equal('mcp')
      expect(normalizeScope('mcp mcp')).to.equal('mcp')
      expect(normalizeScope('mcp\tmcp')).to.equal('mcp')
    })

    it('returns null for any scope beyond mcp', () => {
      expect(normalizeScope('admin')).to.be.null
      expect(normalizeScope('mcp admin')).to.be.null
      expect(normalizeScope('MCP')).to.be.null
      expect(normalizeScope('mcp:read')).to.be.null
    })

    it('returns null for a non-string scope', () => {
      expect(normalizeScope(['mcp'])).to.be.null
      expect(normalizeScope({ $ne: 'x' })).to.be.null
      expect(normalizeScope(42)).to.be.null
    })
  })

  describe('hashToken', () => {
    it('returns the sha256 hex digest, never the token itself', () => {
      const token = 'oar_example'
      expect(hashToken(token)).to.equal(
        crypto.createHash('sha256').update(token).digest('hex')
      )
      expect(hashToken(token)).to.not.include(token)
    })
  })

  describe('base64url', () => {
    it('encodes without padding and with URL-safe characters', () => {
      const buf = Buffer.from([0xfb, 0xff, 0xbf])
      expect(base64url(buf)).to.equal('-_-_')
      expect(base64url('hi')).to.equal('aGk')
    })
  })

  describe('getBaseUrl', () => {
    it('prefers the configured site URL and strips trailing slashes', () => {
      const original = Settings.siteUrl
      try {
        Settings.siteUrl = 'https://overleaf.example.com//'
        expect(getBaseUrl({ headers: { host: 'other' } })).to.equal(
          'https://overleaf.example.com'
        )
      } finally {
        Settings.siteUrl = original
      }
    })

    it('falls back to the request host when no site URL is set', () => {
      const original = Settings.siteUrl
      try {
        Settings.siteUrl = undefined
        const req = { protocol: 'https', get: h => (h === 'host' ? 'a.test' : '') }
        expect(getBaseUrl(req)).to.equal('https://a.test')
        expect(getBaseUrl({ headers: { host: 'b.test' } })).to.equal('http://b.test')
        expect(getBaseUrl({})).to.equal('http://localhost:3000')
      } finally {
        Settings.siteUrl = original
      }
    })
  })
})
