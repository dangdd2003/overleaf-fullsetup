import { expect } from 'chai'
import { loadConfig } from '../../../src/config.js'

const BASE = {
  MCP_ENABLED: 'true',
  OVERLEAF_INTERNAL_URL: 'http://web:3000',
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

    it('applies the documented defaults', function () {
      const config = loadConfig(BASE)
      expect(config.transport).to.equal('http')
      expect(config.host).to.equal('127.0.0.1')
      expect(config.port).to.equal(3050)
      expect(config.endpointPath).to.equal('/mcp')
      expect(config.maxUploadBytes).to.equal(20 * 1024 * 1024)
      expect(config.resourceUri).to.equal('http://127.0.0.1:3050/mcp')
      expect(config.authServerUrl).to.equal('http://web:3000')
    })

    it('falls back to OVERLEAF_SITE_URL when OVERLEAF_INTERNAL_URL is absent', function () {
      const config = loadConfig({
        MCP_ENABLED: 'true',
        OVERLEAF_SITE_URL: 'http://web:3000',
      })
      expect(config.internalUrl).to.equal('http://web:3000')
    })

    it('strips a trailing slash from the internal URL', function () {
      const config = loadConfig({ ...BASE, OVERLEAF_INTERNAL_URL: 'http://web:3000/' })
      expect(config.internalUrl).to.equal('http://web:3000')
    })

    it('throws when enabled without an internal URL', function () {
      expect(() => loadConfig({ MCP_ENABLED: 'true' })).to.throw(
        /OVERLEAF_INTERNAL_URL/
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
