import { describe, it } from 'vitest'
import { expect } from 'chai'
import {
  presetFor,
  presetView,
  parseConnectorConfig,
} from '../../../../app/src/connectors/ConnectorPresets.mjs'

function only(connectors) {
  expect(connectors).to.have.lengthOf(1)
  return connectors[0]
}

describe('ConnectorPresets', function () {
  describe('presetFor', function () {
    it('gives the Google preset for Google API endpoints', function () {
      for (const url of [
        'https://calendar.googleapis.com/mcp',
        'https://drive.GOOGLEAPIS.com/mcp',
        'https://googleapis.com/mcp',
      ]) {
        expect(presetFor(url).id, url).to.equal('google')
      }
    })

    it('gives no preset for other hosts, including look-alikes', function () {
      for (const url of [
        'https://mcp.example.com/mcp',
        'https://evilgoogleapis.com/mcp',
        'https://googleapis.com.example.net/mcp',
      ]) {
        expect(presetFor(url), url).to.be.null
      }
    })

    it('gives no preset for something that is not a URL', function () {
      expect(presetFor('not a url')).to.be.null
    })
  })

  describe('presetView', function () {
    it('shows the preset to the browser without internal flags', function () {
      const view = presetView(presetFor('https://calendar.googleapis.com/mcp'))

      expect(view.id).to.equal('google')
      expect(view.needsClient).to.be.true
      expect(view.clientHelpUrl).to.equal('https://console.cloud.google.com/auth/clients')
      expect(view.oauth.authorizationUrl).to.equal(
        'https://accounts.google.com/o/oauth2/v2/auth'
      )
      expect(view).to.not.have.property('omitResource')
    })

    it('returns null when there is no preset', function () {
      expect(presetView(null)).to.be.null
    })
  })

  describe('parseConnectorConfig', function () {
    it('reads a Gemini CLI remote server: httpUrl, headers, timeout in milliseconds', function () {
      const { connectors, skipped } = parseConnectorConfig({
        mcpServers: {
          docs: {
            httpUrl: 'https://mcp.example.com/mcp',
            headers: { 'X-Team': 'research', 'X-Empty': null },
            timeout: 45_000,
          },
        },
      })

      expect(skipped).to.deep.equal([])
      expect(only(connectors)).to.deep.include({
        name: 'docs',
        url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http',
        authMode: 'auto',
        timeoutSeconds: 45,
      })
      expect(only(connectors).headers).to.deep.equal([
        { name: 'X-Team', value: 'research' },
      ])
    })

    it('maps trust and tool filters onto per-tool permissions', function () {
      const trusted = only(
        parseConnectorConfig({
          mcpServers: {
            a: { url: 'https://a.example.com', trust: true, excludeTools: ['drop_table'] },
          },
        }).connectors
      )
      expect(trusted.toolPermissions).to.deep.equal({ '*': 'allow', drop_table: 'block' })

      const filtered = only(
        parseConnectorConfig({
          mcpServers: {
            b: { url: 'https://b.example.com', includeTools: ['search', 'read'] },
          },
        }).connectors
      )
      expect(filtered.toolPermissions).to.deep.equal({
        search: 'ask',
        read: 'ask',
        '*': 'block',
      })
    })

    it('allows the listed tools outright when the server is trusted', function () {
      const { toolPermissions } = only(
        parseConnectorConfig({
          mcpServers: {
            c: {
              url: 'https://c.example.com',
              trust: true,
              includeTools: ['search'],
            },
          },
        }).connectors
      )

      expect(toolPermissions).to.deep.equal({ search: 'allow', '*': 'block' })
    })

    it('uses SSE transport for type sse, and automatic transport when no type is given', function () {
      const { connectors } = parseConnectorConfig({
        servers: {
          legacy: { type: 'sse', url: 'https://legacy.example.com/sse' },
          modern: { type: 'http', url: 'https://modern.example.com/mcp' },
          plain: { url: 'https://plain.example.com/mcp' },
        },
      })
      const byName = Object.fromEntries(connectors.map(c => [c.name, c.transport]))

      expect(byName).to.deep.equal({
        legacy: 'sse',
        modern: 'streamable-http',
        plain: 'auto',
      })
    })

    it('reads the Claude API mcp_servers list, turning authorization_token into a bearer header', function () {
      const { connectors } = parseConnectorConfig({
        mcp_servers: [
          {
            name: 'claude-side',
            type: 'url',
            url: 'https://api.example.com/mcp',
            authorization_token: 'tok-123',
          },
        ],
      })

      expect(only(connectors).name).to.equal('claude-side')
      expect(only(connectors).headers).to.deep.equal([
        { name: 'Authorization', value: 'Bearer tok-123' },
      ])
    })

    it('skips a local stdio program, which Overleaf cannot run', function () {
      const { connectors, skipped } = parseConnectorConfig({
        mcpServers: {
          local: { command: 'npx', args: ['some-server'] },
          remote: { url: 'https://mcp.example.com' },
        },
      })

      expect(connectors.map(c => c.name)).to.deep.equal(['remote'])
      expect(skipped).to.have.lengthOf(1)
      expect(skipped[0].name).to.equal('local')
      expect(skipped[0].reason).to.match(/local program/)
    })

    it('skips an entry with no URL, and a Google service-account impersonation', function () {
      const { connectors, skipped } = parseConnectorConfig({
        mcpServers: {
          empty: { type: 'http' },
          impersonating: {
            url: 'https://calendar.googleapis.com/mcp',
            authProviderType: 'service_account_impersonation',
          },
        },
      })

      expect(connectors).to.have.lengthOf(0)
      expect(skipped.map(s => s.name)).to.deep.equal(['empty', 'impersonating'])
      expect(skipped[0].reason).to.equal('No URL')
      expect(skipped[1].reason).to.match(/impersonating a Google service account/)
    })

    it('turns Google credentials into the Google preset, signing in by OAuth', function () {
      const input = only(
        parseConnectorConfig({
          mcpServers: {
            calendar: {
              url: 'https://calendar.googleapis.com/mcp',
              authProviderType: 'google_credentials',
            },
          },
        }).connectors
      )

      expect(input.authMode).to.equal('oauth')
      expect(input.oauth.clientMode).to.equal('custom')
      expect(input.oauth.scopes).to.equal(
        'https://www.googleapis.com/auth/cloud-platform'
      )
      expect(input.oauth.extraParams).to.deep.include({
        name: 'access_type',
        value: 'offline',
      })
      expect(input.oauth).to.not.have.property('issuer')
    })

    it('carries an explicit OAuth block over, with audiences as an audience parameter', function () {
      const input = only(
        parseConnectorConfig({
          mcpServers: {
            api: {
              url: 'https://api.example.com/mcp',
              oauth: {
                enabled: true,
                clientId: 'cid',
                clientSecret: 'csec',
                authorizationUrl: 'https://auth.example.com/authorize',
                tokenUrl: 'https://auth.example.com/token',
                scopes: ['read', 'write'],
                audiences: ['https://api.example.com/'],
              },
            },
          },
        }).connectors
      )

      expect(input.authMode).to.equal('oauth')
      expect(input.oauth).to.include({
        clientMode: 'custom',
        clientId: 'cid',
        clientSecret: 'csec',
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        scopes: 'read write',
      })
      expect(input.oauth.extraParams).to.deep.equal([
        { name: 'audience', value: 'https://api.example.com/' },
      ])
    })

    it('leaves the sign-in mode automatic when an OAuth block is not enabled', function () {
      const input = only(
        parseConnectorConfig({
          mcpServers: {
            api: {
              url: 'https://api.example.com/mcp',
              oauth: { scopes: 'read' },
            },
          },
        }).connectors
      )

      expect(input.authMode).to.equal('auto')
      expect(input.oauth.scopes).to.equal('read')
    })

    it('accepts the config as JSON text or as an object, with the same result', function () {
      const config = {
        mcpServers: { docs: { httpUrl: 'https://mcp.example.com/mcp' } },
      }

      expect(parseConnectorConfig(JSON.stringify(config))).to.deep.equal(
        parseConnectorConfig(config)
      )
    })

    it('reports text that is not JSON as a 400', function () {
      let error = null
      try {
        parseConnectorConfig('{ not json')
      } catch (err) {
        error = err
      }
      expect(error.status).to.equal(400)
      expect(error.message).to.match(/not valid JSON/)
    })

    it('reports an empty configuration as a 400', function () {
      let error = null
      try {
        parseConnectorConfig(null)
      } catch (err) {
        error = err
      }
      expect(error.status).to.equal(400)
      expect(error.message).to.match(/empty/)
    })
  })
})
