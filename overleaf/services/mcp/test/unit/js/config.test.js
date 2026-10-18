import { expect } from 'chai'
import { loadConfig } from '../../../src/config.js'

const BASE = {
  MCP_ENABLED: 'true',
  MCP_INTERNAL_URL: 'http://web:3000',
  OVERLEAF_SITE_URL: 'https://overleaf.example.com',
}

describe('config', function () {
  describe('loadConfig', function () {
    it('defaults to disabled when the flag is absent', function () {
      const config = loadConfig({})
      expect(config.enabled).to.be.false
    })

    it('treats any value other than "true" as disabled', function () {
      expect(loadConfig({ MCP_ENABLED: 'yes' }).enabled).to.be.false
      expect(loadConfig({ MCP_ENABLED: '1' }).enabled).to.be.false
      expect(loadConfig({ ...BASE, MCP_ENABLED: 'TRUE' }).enabled).to.be.true
    })

    it('rejects a numeric setting with trailing characters instead of reading its digits', function () {
      expect(() => loadConfig({ ...BASE, MCP_PORT: '3050abc' })).to.throw(/MCP_PORT must be a positive integer/)
      expect(() => loadConfig({ ...BASE, MCP_PORT: '1e3' })).to.throw(/MCP_PORT/)
    })

    it('applies the documented defaults', function () {
      const config = loadConfig(BASE)
      expect(config.transport).to.equal('http')
      expect(config.host).to.equal('127.0.0.1')
      expect(config.port).to.equal(3050)
      expect(config.endpointPath).to.equal('/mcp')
      expect(config.maxBodyMb).to.equal(70)
      expect(config).to.not.have.property('maxUploadBytes')
      expect(config.resourceUri).to.equal('https://overleaf.example.com/mcp')
      expect(config.authServerUrl).to.equal('https://overleaf.example.com')
    })

    it('customizes maxBodyMb with MCP_MAX_BODY_MB', function () {
      const config = loadConfig({ ...BASE, MCP_MAX_BODY_MB: '100' })
      expect(config.maxBodyMb).to.equal(100)
    })

    it('requires OVERLEAF_SITE_URL for the http transport, since it is the token issuer', function () {
      expect(() =>
        loadConfig({ MCP_ENABLED: 'true', MCP_INTERNAL_URL: 'http://web:3000' })
      ).to.throw(/OVERLEAF_SITE_URL/)
    })

    it('does not require OVERLEAF_SITE_URL for the stdio transport', function () {
      expect(() =>
        loadConfig({
          MCP_ENABLED: 'true',
          MCP_INTERNAL_URL: 'http://web:3000',
          MCP_TRANSPORT: 'stdio',
          MCP_TOKEN: 'olp_deadbeef',
        })
      ).to.not.throw()
    })

    it('falls back to OVERLEAF_SITE_URL when MCP_INTERNAL_URL is absent', function () {
      const config = loadConfig({
        MCP_ENABLED: 'true',
        OVERLEAF_SITE_URL: 'http://web:3000',
      })
      expect(config.internalUrl).to.equal('http://web:3000')
    })

    it('strips a trailing slash from the internal URL', function () {
      const config = loadConfig({ ...BASE, MCP_INTERNAL_URL: 'http://web:3000/' })
      expect(config.internalUrl).to.equal('http://web:3000')
    })

    it('throws when enabled without an internal URL', function () {
      expect(() => loadConfig({ MCP_ENABLED: 'true' })).to.throw(
        /MCP_INTERNAL_URL/
      )
    })

    it('does not validate the internal URL when disabled', function () {
      expect(() => loadConfig({})).to.not.throw()
    })

    it('rejects an unknown transport', function () {
      expect(() => loadConfig({ ...BASE, MCP_TRANSPORT: 'websocket' })).to.throw(
        /MCP_TRANSPORT/
      )
    })

    it('does not validate transport when disabled', function () {
      expect(() => loadConfig({ MCP_TRANSPORT: 'invalid' })).to.not.throw()
    })

    it('requires MCP_TOKEN for the stdio transport', function () {
      expect(() => loadConfig({ ...BASE, MCP_TRANSPORT: 'stdio' })).to.throw(
        /MCP_TOKEN/
      )
      const config = loadConfig({
        ...BASE,
        MCP_TRANSPORT: 'stdio',
        MCP_TOKEN: 'olp_deadbeef',
      })
      expect(config.stdioToken).to.equal('olp_deadbeef')
    })

    it('requires an explicit allowed-hosts list when binding to all interfaces', function () {
      expect(() => loadConfig({ ...BASE, MCP_HOST: '0.0.0.0' })).to.throw(
        /MCP_ALLOWED_HOSTS/
      )
      const config = loadConfig({
        ...BASE,
        MCP_HOST: '0.0.0.0',
        MCP_ALLOWED_HOSTS: 'overleaf.example.com, mcp.example.com',
      })
      expect(config.allowedHosts).to.deep.equal([
        'overleaf.example.com',
        'mcp.example.com',
      ])
    })

    it('rejects a wildcard origin', function () {
      expect(() => loadConfig({ ...BASE, MCP_ALLOWED_ORIGINS: '*' })).to.throw(
        /wildcard/
      )
    })

    it('returns a frozen object', function () {
      expect(Object.isFrozen(loadConfig(BASE))).to.be.true
    })
  })
})
