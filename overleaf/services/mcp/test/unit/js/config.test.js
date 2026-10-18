import { expect } from 'chai'
import { loadConfig, WEB_INTERNAL_URL } from '../../../src/config.js'

const BASE = {
  MCP_ENABLED: 'true',
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

    it('does not validate the site URL when disabled', function () {
      expect(() => loadConfig({})).to.not.throw()
    })

    it('applies the fixed http defaults', function () {
      const config = loadConfig(BASE)
      expect(config.transport).to.equal('http')
      expect(config.host).to.equal('127.0.0.1')
      expect(config.port).to.equal(3050)
      expect(config.endpointPath).to.equal('/mcp')
      expect(config.maxBodyMb).to.equal(70)
      expect(config.internalUrl).to.equal(WEB_INTERNAL_URL)
      expect(config.resourceUri).to.equal('https://overleaf.example.com/mcp')
      expect(config.authServerUrl).to.equal('https://overleaf.example.com')
    })

    it('ignores the variables that are no longer read', function () {
      const config = loadConfig({
        ...BASE,
        MCP_TRANSPORT: 'stdio',
        MCP_HOST: '0.0.0.0',
        MCP_PORT: '9999',
        MCP_ENDPOINT_PATH: '/other',
        MCP_INTERNAL_URL: 'http://elsewhere:3000',
        MCP_RESOURCE_URI: 'https://elsewhere.example.com/mcp',
        MCP_MAX_BODY_MB: '100',
      })
      expect(config.transport).to.equal('http')
      expect(config.host).to.equal('127.0.0.1')
      expect(config.port).to.equal(3050)
      expect(config.endpointPath).to.equal('/mcp')
      expect(config.internalUrl).to.equal(WEB_INTERNAL_URL)
      expect(config.resourceUri).to.equal('https://overleaf.example.com/mcp')
      expect(config.maxBodyMb).to.equal(70)
    })

    it('adds MCP_ALLOWED_HOSTS and MCP_ALLOWED_ORIGINS to the derived lists', function () {
      const config = loadConfig({
        ...BASE,
        MCP_ALLOWED_HOSTS: 'other.example.com, 10.0.0.5',
        MCP_ALLOWED_ORIGINS: 'https://app.example.com',
      })
      expect(config.allowedHosts).to.include.members([
        'overleaf.example.com',
        'other.example.com',
        '10.0.0.5',
      ])
      expect(config.allowedOrigins).to.include.members([
        'https://overleaf.example.com',
        'https://app.example.com',
      ])
    })

    it('refuses a wildcard in MCP_ALLOWED_ORIGINS', function () {
      expect(() =>
        loadConfig({ ...BASE, MCP_ALLOWED_ORIGINS: '*' })
      ).to.throw(/wildcard/)
    })

    it('requires OVERLEAF_SITE_URL when enabled, since it is the token issuer', function () {
      expect(() => loadConfig({ MCP_ENABLED: 'true' })).to.throw(
        /OVERLEAF_SITE_URL/
      )
    })

    it('requires an absolute OVERLEAF_SITE_URL', function () {
      expect(() =>
        loadConfig({ MCP_ENABLED: 'true', OVERLEAF_SITE_URL: 'overleaf' })
      ).to.throw(/absolute URL/)
    })

    it('strips a trailing slash from the site URL', function () {
      const config = loadConfig({
        ...BASE,
        OVERLEAF_SITE_URL: 'https://overleaf.example.com/',
      })
      expect(config.authServerUrl).to.equal('https://overleaf.example.com')
      expect(config.resourceUri).to.equal('https://overleaf.example.com/mcp')
    })

    it('admits the public hostname nginx forwards, plus loopback', function () {
      const config = loadConfig({
        ...BASE,
        OVERLEAF_SITE_URL: 'https://overleaf.example.com:8443',
      })
      expect(config.allowedHosts).to.deep.equal([
        '127.0.0.1',
        'localhost',
        '[::1]',
        'overleaf.example.com',
      ])
      expect(config.allowedOrigins).to.include('https://overleaf.example.com:8443')
    })

    it('returns a frozen object', function () {
      expect(Object.isFrozen(loadConfig(BASE))).to.be.true
      expect(Object.isFrozen(loadConfig(BASE).allowedHosts)).to.be.true
    })

    describe('stdio', function () {
      it('serves the site given by OVERLEAF_SITE_URL instead of web', function () {
        const config = loadConfig(
          { ...BASE, MCP_TOKEN: 'olp_deadbeef' },
          { stdio: true }
        )
        expect(config.transport).to.equal('stdio')
        expect(config.internalUrl).to.equal('https://overleaf.example.com')
        expect(config.stdioToken).to.equal('olp_deadbeef')
      })

      it('requires MCP_TOKEN', function () {
        expect(() => loadConfig(BASE, { stdio: true })).to.throw(/MCP_TOKEN/)
      })

      it('requires OVERLEAF_SITE_URL', function () {
        expect(() =>
          loadConfig({ MCP_ENABLED: 'true', MCP_TOKEN: 'olp_deadbeef' }, { stdio: true })
        ).to.throw(/OVERLEAF_SITE_URL/)
      })
    })
  })
})
