import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { expect } from 'chai'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import {
  ConnectorModel,
  ConnectorCredentialModel,
  OAuthStateModel,
} from '../../../../app/src/connectors/ConnectorModel.mjs'
import { open, seal } from '../../../../app/src/connectors/ConnectorCrypto.mjs'
import {
  McpClient,
  ConnectorAuthError,
} from '../../../../app/src/connectors/McpClient.mjs'
import {
  toView,
  getMeta,
  ConnectorService,
} from '../../../../app/src/connectors/ConnectorService.mjs'

const CONNECTOR_ID = '507f1f77bcf86cd799439011'
const OTHER_ID = '507f1f77bcf86cd799439012'
const USER_ID = '607f1f77bcf86cd799439099'

// A chainable stand-in for a mongoose query
function query(result) {
  const q = {
    sort: () => q,
    lean: () => q,
    exec: async () => result,
  }
  return q
}

function credentialsCtx(id, field) {
  return `aiAssistConnectorCredentials:${id}:${field}`
}

describe('ConnectorService', function () {
  const originalSecurity = Settings.security
  const originalSiteUrl = Settings.siteUrl

  beforeEach(function () {
    Settings.security = { sessionSecret: 'service-test-session-secret-0123456789' }
    Settings.siteUrl = 'https://overleaf.example.com'
  })

  afterEach(function () {
    vi.restoreAllMocks()
    Settings.security = originalSecurity
    Settings.siteUrl = originalSiteUrl
  })

  describe('toView', function () {
    it('returns null for null/undefined input', function () {
      expect(toView(null)).to.be.null
      expect(toView(undefined)).to.be.null
    })

    it('shows header names and secret flags, never the values', function () {
      const doc = {
        _id: CONNECTOR_ID,
        name: 'GitHub API Server',
        url: 'https://mcp.github.example.com',
        transport: 'streamable-http',
        authMode: 'oauth',
        enabled: true,
        status: 'connected',
        headerNames: ['x-api-key'],
        hasClientSecret: true,
        oauth: {
          clientMode: 'custom',
          customClientId: 'client-abc',
          scopes: 'repo read:user',
          authorizationUrl: 'https://github.com/login/oauth/authorize',
          tokenUrl: 'https://github.com/login/oauth/access_token',
          tokenEndpointAuthMethod: 'client_secret_post',
          extraParams: [{ name: 'audience', value: 'api' }],
          issuer: 'https://github.com',
          registration: 'custom',
          grantedScopes: 'repo',
          hasRefreshToken: true,
        },
        server: { name: 'github-mcp', instructions: 'Manage repositories.' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      }

      const view = toView(doc)

      expect(view.id).to.equal(CONNECTOR_ID)
      expect(view.headers).to.deep.equal([{ name: 'x-api-key', hasValue: true }])
      expect(view.oauth.clientId).to.equal('client-abc')
      expect(view.oauth.hasClientSecret).to.be.true
      expect(view.oauth.hasRefreshToken).to.be.true
      expect(view.oauth.extraParams).to.deep.equal([{ name: 'audience', value: 'api' }])
      expect(view.server.name).to.equal('github-mcp')
      expect(view.server.instructions).to.equal('Manage repositories.')
      expect(view.createdAt).to.equal('2026-01-01T00:00:00.000Z')
      expect(JSON.stringify(view)).to.not.match(/encrypted|enc_/)
    })

    it('derives tool hints from MCP annotations, falling back to bare names', function () {
      const doc = {
        _id: CONNECTOR_ID,
        name: 'docs',
        url: 'https://mcp.example.com',
        tools: [
          { name: 'search', annotations: { readOnlyHint: true, destructiveHint: false } },
          { name: 'delete_item', annotations: { destructive: true } },
          { name: 'web_lookup', annotations: { openWorldHint: true } },
          { name: 'plain' },
        ],
        toolPermissions: { '*': 'block', search: 'allow' },
      }

      const view = toView(doc)
      const [search, remove, lookup, plain] = view.tools

      expect(search).to.include({ readOnly: true, destructive: false, permission: 'allow' })
      expect(remove).to.include({ destructive: true, permission: 'block' })
      expect(lookup).to.include({ openWorld: true, readOnly: false })
      expect(plain).to.include({ readOnly: false, destructive: false, openWorld: false })
      expect(plain.permission).to.equal('block')
      expect(view.defaultPermission).to.equal('block')
    })

    it('reads a hint saved at the top level of a tool as well as one in its annotations', function () {
      const view = toView({
        _id: CONNECTOR_ID,
        name: 'docs',
        url: 'https://mcp.example.com',
        tools: [{ name: 'search', readOnlyHint: true, destructive: true }],
      })

      expect(view.tools[0]).to.include({ readOnly: true, destructive: true })
    })

    it('defaults a tool to ask, and the timeout to none', function () {
      const view = toView({
        _id: CONNECTOR_ID,
        name: 'docs',
        url: 'https://mcp.example.com',
        tools: [{ name: 'search' }],
        timeoutSeconds: 0,
      })

      expect(view.tools[0].permission).to.equal('ask')
      expect(view.defaultPermission).to.equal('ask')
      expect(view.timeoutSeconds).to.be.null
    })

    it('reports a configured timeout in seconds', function () {
      const view = toView({
        _id: CONNECTOR_ID,
        name: 'slow',
        url: 'https://mcp.example.com',
        timeoutSeconds: 120,
      })

      expect(view.timeoutSeconds).to.equal(120)
    })

    it('attaches the known-server preset for Google endpoints', function () {
      const view = toView({
        _id: CONNECTOR_ID,
        name: 'Calendar',
        url: 'https://calendar.googleapis.com/mcp',
      })

      expect(view.preset.id).to.equal('google')
      expect(view.preset.needsClient).to.be.true
      expect(view.preset).to.not.have.property('omitResource')
    })

    it('reports the last error with its code', function () {
      const view = toView({
        _id: CONNECTOR_ID,
        name: 'broken',
        url: 'https://mcp.example.com',
        status: 'error',
        lastError: {
          message: 'HTTP 500',
          code: 'CONNECT_ERROR',
          at: new Date('2026-03-01T10:00:00Z'),
        },
      })

      expect(view.lastError).to.deep.equal({
        message: 'HTTP 500',
        code: 'CONNECT_ERROR',
        at: '2026-03-01T10:00:00.000Z',
      })
    })
  })

  describe('connect', function () {
    it('saves each tool with its title and annotations, and the server instructions', async function () {
      vi.spyOn(McpClient.prototype, 'connect').mockResolvedValue(undefined)
      vi.spyOn(McpClient.prototype, 'listTools').mockResolvedValue([
        {
          name: 'search',
          title: 'Search',
          description: 'Find things.',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
      ])
      const connector = {
        _id: CONNECTOR_ID,
        name: 'docs',
        url: 'https://mcp.example.com/mcp',
        transport: 'auto',
        authMode: 'none',
        oauth: {},
        save: vi.fn(async () => {}),
      }

      const next = await ConnectorService.connect(connector, {
        headers: {},
        lost: [],
        tokens: null,
      })

      expect(next).to.equal('connected')
      expect(connector.status).to.equal('connected')
      expect(connector.tools[0].toObject ? connector.tools[0].toObject() : connector.tools[0]).to.include({
        name: 'search',
        title: 'Search',
        description: 'Find things.',
      })
      expect(connector.tools[0].annotations).to.deep.equal({
        readOnlyHint: true,
        openWorldHint: false,
      })
    })
  })

  describe('getMeta', function () {
    it('gives the redirect URI and no client metadata URL for a private site', function () {
      Settings.siteUrl = 'http://localhost:8080'
      const meta = getMeta()

      expect(meta.redirectUri).to.equal(
        'http://localhost:8080/ai-assist/connectors/oauth/callback'
      )
      expect(meta.clientMetadataUrl).to.be.null
      expect(meta).to.not.have.property('maxPerUser')
    })

    it('offers the client metadata URL for a public https site', function () {
      const meta = getMeta()

      expect(meta.clientMetadataUrl).to.equal(
        'https://overleaf.example.com/ai-assist/connectors/oauth/client-metadata.json'
      )
    })
  })

  describe('list', function () {
    it('shows each connector with whether it holds a client secret, and no secret values', async function () {
      const secret = 'top-secret-client-value'
      const docs = [
        { _id: CONNECTOR_ID, name: 'a', url: 'https://a.example.com' },
        { _id: OTHER_ID, name: 'b', url: 'https://b.example.com' },
      ]
      vi.spyOn(ConnectorModel, 'find').mockReturnValue(query(docs))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockImplementation(filter =>
        query(
          filter.connector_id === CONNECTOR_ID
            ? {
                clientSecret: seal(
                  secret,
                  credentialsCtx(CONNECTOR_ID, 'clientSecret')
                ),
              }
            : null
        )
      )

      const { connectors } = await ConnectorService.list(USER_ID)

      expect(connectors.map(c => c.oauth.hasClientSecret)).to.deep.equal([true, false])
      expect(JSON.stringify(connectors)).to.not.include(secret)
    })
  })

  describe('create', function () {
    // Stubs the database writes; the MCP connect is stubbed per test
    function stubStores() {
      vi.spyOn(ConnectorModel.prototype, 'save').mockResolvedValue(undefined)
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      return vi
        .spyOn(ConnectorCredentialModel, 'updateOne')
        .mockReturnValue({ exec: async () => undefined })
    }

    it('seals the headers to the connector and leaves it waiting for sign-in for oauth mode', async function () {
      const updateOne = stubStores()
      vi.spyOn(ConnectorService, '_signInOffered').mockResolvedValue(true)
      vi.spyOn(McpClient.prototype, 'connect').mockRejectedValue(
        new ConnectorAuthError('Unauthorized', { status: 401 })
      )

      const { connector, next } = await ConnectorService.create(USER_ID, {
        name: 'Docs',
        url: 'https://mcp.example.com',
        authMode: 'oauth',
        headers: [{ name: 'X-Api-Key', value: 'k-123' }],
      })

      expect(next).to.equal('authorize')
      expect(connector.status).to.equal('needs_auth')
      expect(connector.headers).to.deep.equal([{ name: 'X-Api-Key', hasValue: true }])

      const sealed = updateOne.mock.calls[0][1].$set.headers
      expect(sealed.startsWith('v2:')).to.be.true
      expect(sealed).to.not.include('k-123')
      // Sealed to this connector: it opens for it and for nothing else
      expect(
        open(sealed, credentialsCtx(connector.id, 'headers'))
      ).to.deep.equal({ 'X-Api-Key': 'k-123' })
    })

    it('connects straight away in oauth mode when the server needs no sign-in', async function () {
      stubStores()
      vi.spyOn(McpClient.prototype, 'connect').mockResolvedValue(undefined)
      vi.spyOn(McpClient.prototype, 'listTools').mockResolvedValue([
        { name: 'search', description: 'Find things.', inputSchema: { type: 'object' } },
      ])

      const { connector, next } = await ConnectorService.create(USER_ID, {
        name: 'Open',
        url: 'https://mcp.example.com',
        authMode: 'oauth',
      })

      expect(next).to.equal('connected')
      expect(connector.status).to.equal('connected')
      expect(connector.tools).to.have.lengthOf(1)
      expect(connector.tools[0].name).to.equal('search')
      expect(connector.lastConnectedAt).to.exist
      expect(connector.lastError).to.not.exist
    })

    it('asks for sign-in in auto mode when the server sends an auth challenge', async function () {
      stubStores()
      vi.spyOn(ConnectorService, '_signInOffered').mockResolvedValue(true)
      vi.spyOn(McpClient.prototype, 'connect').mockRejectedValue(
        new ConnectorAuthError('Unauthorized', {
          status: 401,
          wwwAuthenticate: 'Bearer realm="mcp"',
        })
      )

      const { connector, next } = await ConnectorService.create(USER_ID, {
        name: 'Auto',
        url: 'https://mcp.example.com',
        authMode: 'auto',
      })

      expect(next).to.equal('authorize')
      expect(connector.status).to.equal('needs_auth')
      expect(connector.lastError).to.not.exist
    })

    it('reports an error with its message when the server cannot be reached', async function () {
      stubStores()
      vi.spyOn(McpClient.prototype, 'connect').mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:443')
      )

      const { connector, next } = await ConnectorService.create(USER_ID, {
        name: 'Down',
        url: 'https://mcp.example.com',
        authMode: 'auto',
      })

      expect(next).to.equal('error')
      expect(connector.status).to.equal('error')
      expect(connector.lastError.message).to.equal('connect ECONNREFUSED 127.0.0.1:443')
      expect(connector.lastError.code).to.equal('CONNECT_ERROR')
    })

    it('reports an error, never a sign-in request, when authMode is none and the server asks for auth', async function () {
      stubStores()
      vi.spyOn(McpClient.prototype, 'connect').mockRejectedValue(
        new ConnectorAuthError('Unauthorized', { status: 401 })
      )

      const { connector, next } = await ConnectorService.create(USER_ID, {
        name: 'NoAuth',
        url: 'https://mcp.example.com',
        authMode: 'none',
      })

      expect(next).to.equal('error')
      expect(connector.status).to.equal('error')
      expect(connector.lastError.message).to.equal('Unauthorized')
    })

    it('reports an error with guidance, not a sign-in button, when a 401 offers no sign-in', async function () {
      stubStores()
      vi.spyOn(ConnectorService, '_signInOffered').mockResolvedValue(false)
      vi.spyOn(McpClient.prototype, 'connect').mockRejectedValue(
        new ConnectorAuthError('Unauthorized', { status: 401 })
      )

      const { connector, next } = await ConnectorService.create(USER_ID, {
        name: 'ApiKey',
        url: 'https://mcp.example.com',
        authMode: 'auto',
        headers: [{ name: 'X-Api-Key', value: 'k-123' }],
      })

      expect(next).to.equal('error')
      expect(connector.status).to.equal('error')
      expect(connector.lastError.code).to.equal('SIGN_IN_NOT_OFFERED')
      expect(connector.lastError.message).to.match(/offers no sign-in/)
      expect(connector.lastError.message).to.match(/add it as a header/)
    })

    it('reports an error when oauth mode is chosen but the server offers no sign-in', async function () {
      stubStores()
      vi.spyOn(ConnectorService, '_signInOffered').mockResolvedValue(false)
      vi.spyOn(McpClient.prototype, 'connect').mockRejectedValue(
        new ConnectorAuthError('Unauthorized', { status: 401 })
      )

      const { connector, next } = await ConnectorService.create(USER_ID, {
        name: 'Locked',
        url: 'https://mcp.example.com',
        authMode: 'oauth',
      })

      expect(next).to.equal('error')
      expect(connector.status).to.equal('error')
    })

    it('reports an error, not a throw, when the saved credentials cannot be read', async function () {
      vi.spyOn(ConnectorModel.prototype, 'save').mockResolvedValue(undefined)
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue({
        lean: () => ({ exec: async () => { throw new Error('db down') } }),
        exec: async () => { throw new Error('db down') },
        sort: () => ({}),
      })
      const connector = {
        _id: CONNECTOR_ID,
        name: 'Broken',
        url: 'https://mcp.example.com',
        transport: 'auto',
        authMode: 'auto',
        oauth: {},
        save: vi.fn(async () => undefined),
      }

      const next = await ConnectorService.connect(connector)

      expect(next).to.equal('error')
      expect(connector.status).to.equal('error')
      expect(connector.lastError.message).to.equal('db down')
    })
  })

  describe('import', function () {
    it('creates a connector for each remote entry and reports the stdio ones as skipped', async function () {
      const created = vi
        .spyOn(ConnectorService, 'create')
        .mockImplementation(async (userId, input) => ({
          connector: { name: input.name },
          next: 'connected',
        }))

      const result = await ConnectorService.import(USER_ID, {
        mcpServers: {
          local: { command: 'node', args: ['server.js'] },
          remote: { httpUrl: 'https://mcp.example.com/mcp' },
        },
      })

      expect(created.mock.calls).to.have.lengthOf(1)
      expect(result.created.map(c => c.connector.name)).to.deep.equal(['remote'])
      expect(result.skipped).to.have.lengthOf(1)
      expect(result.skipped[0].name).to.equal('local')
      expect(result.skipped[0].reason).to.match(/local program/)
    })

    it('verifies each imported connector with a real connect', async function () {
      vi.spyOn(ConnectorModel.prototype, 'save').mockResolvedValue(undefined)
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      vi.spyOn(ConnectorCredentialModel, 'updateOne').mockReturnValue({
        exec: async () => undefined,
      })
      const connectSpy = vi.spyOn(McpClient.prototype, 'connect')
      // First server answers; the second asks for sign-in
      connectSpy
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new ConnectorAuthError('Unauthorized', { status: 401 }))
      vi.spyOn(McpClient.prototype, 'listTools').mockResolvedValue([])
      vi.spyOn(ConnectorService, '_signInOffered').mockResolvedValue(true)

      const result = await ConnectorService.import(USER_ID, {
        mcpServers: {
          open: { httpUrl: 'https://open.example.com/mcp' },
          locked: { httpUrl: 'https://locked.example.com/mcp' },
        },
      })

      expect(connectSpy.mock.calls).to.have.lengthOf(2)
      expect(result.created.map(c => c.connector.name)).to.deep.equal(['open', 'locked'])
      expect(result.created.map(c => c.next)).to.deep.equal(['connected', 'authorize'])
      expect(result.created[1].connector.status).to.equal('needs_auth')
    })
  })

  describe('update', function () {
    function ownedDoc(overrides = {}) {
      return {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        name: 'Docs',
        url: 'https://mcp.example.com',
        transport: 'auto',
        authMode: 'auto',
        enabled: true,
        toolPermissions: { '*': 'ask', search: 'allow' },
        tools: [],
        oauth: {},
        save: vi.fn(async () => undefined),
        markModified: vi.fn(),
        ...overrides,
      }
    }

    it('merges tool permissions into the saved ones without reconnecting', async function () {
      const doc = ownedDoc()
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(doc))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      const connect = vi.spyOn(ConnectorService, 'connect')

      const { connector } = await ConnectorService.update(CONNECTOR_ID, USER_ID, {
        toolPermissions: { delete_item: 'block' },
      })

      expect(doc.toolPermissions).to.deep.equal({
        '*': 'ask',
        search: 'allow',
        delete_item: 'block',
      })
      expect(doc.markModified.mock.calls).to.deep.include(['toolPermissions'])
      expect(connect.mock.calls).to.have.lengthOf(0)
      expect(connector.defaultPermission).to.equal('ask')
    })

    it('reconnects when the server URL changes', async function () {
      const doc = ownedDoc()
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(doc))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      const saveCreds = vi
        .spyOn(ConnectorCredentialModel, 'updateOne')
        .mockReturnValue(query({}))
      const connect = vi
        .spyOn(ConnectorService, 'connect')
        .mockResolvedValue('connected')

      await ConnectorService.update(CONNECTOR_ID, USER_ID, {
        url: 'https://mcp2.example.com',
      })

      expect(connect.mock.calls).to.have.lengthOf(1)
      expect(doc.url).to.equal('https://mcp2.example.com')
      // Secrets for the old host are not carried over to the new one
      const [, update] = saveCreds.mock.calls[0]
      expect(update.$unset).to.deep.equal({ headers: '', tokens: '', clientSecret: '' })
      expect(doc.headerNames).to.deep.equal([])
    })

    it('returns the reconnect result as next when the URL changes', async function () {
      for (const outcome of ['connected', 'authorize', 'error']) {
        vi.restoreAllMocks()
        const doc = ownedDoc()
        vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(doc))
        vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
        vi.spyOn(ConnectorCredentialModel, 'updateOne').mockReturnValue(query({}))
        vi.spyOn(ConnectorService, 'connect').mockResolvedValue(outcome)

        const { next } = await ConnectorService.update(CONNECTOR_ID, USER_ID, {
          url: 'https://mcp2.example.com',
        })

        expect(next).to.equal(outcome)
      }
    })

    it('returns next as null when only the name changes', async function () {
      const doc = ownedDoc()
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(doc))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      const connect = vi.spyOn(ConnectorService, 'connect')

      const { connector, next } = await ConnectorService.update(CONNECTOR_ID, USER_ID, {
        name: 'Renamed',
      })

      expect(next).to.be.null
      expect(connect.mock.calls).to.have.lengthOf(0)
      expect(connector.name).to.equal('Renamed')
    })

    it('returns next as null when the URL changes on a disabled connector', async function () {
      const doc = ownedDoc({ enabled: false })
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(doc))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      vi.spyOn(ConnectorCredentialModel, 'updateOne').mockReturnValue(query({}))
      const connect = vi.spyOn(ConnectorService, 'connect')

      const { next } = await ConnectorService.update(CONNECTOR_ID, USER_ID, {
        url: 'https://mcp2.example.com',
      })

      expect(next).to.be.null
      expect(connect.mock.calls).to.have.lengthOf(0)
    })

    it('answers 404 for a connector the user does not own', async function () {
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(null))

      let error = null
      try {
        await ConnectorService.update(CONNECTOR_ID, USER_ID, { name: 'x' })
      } catch (err) {
        error = err
      }
      expect(error.status).to.equal(404)
      expect(error.message).to.equal('Connector not found')
    })
  })

  describe('remove', function () {
    it('answers 404 when nothing was deleted', async function () {
      vi.spyOn(ConnectorModel, 'deleteOne').mockReturnValue({
        exec: async () => ({ deletedCount: 0 }),
      })

      let error = null
      try {
        await ConnectorService.remove(CONNECTOR_ID, USER_ID)
      } catch (err) {
        error = err
      }
      expect(error.status).to.equal(404)
    })

    it('deletes the credentials and any sign-ins in flight with the connector', async function () {
      vi.spyOn(ConnectorModel, 'deleteOne').mockReturnValue({
        exec: async () => ({ deletedCount: 1 }),
      })
      const deleteCredentials = vi
        .spyOn(ConnectorCredentialModel, 'deleteOne')
        .mockReturnValue({ exec: async () => ({}) })
      const deleteStates = vi
        .spyOn(OAuthStateModel, 'deleteMany')
        .mockReturnValue({ exec: async () => ({}) })

      const result = await ConnectorService.remove(CONNECTOR_ID, USER_ID)

      expect(result).to.deep.equal({ ok: true })
      expect(deleteCredentials.mock.calls[0][0]).to.deep.equal({
        connector_id: CONNECTOR_ID,
      })
      expect(deleteStates.mock.calls[0][0]).to.deep.equal({
        connector_id: CONNECTOR_ID,
      })
    })
  })

  describe('origin change and sign-in endpoints', function () {
    it('clears the old server endpoints when the URL moves to another origin', async function () {
      const doc = {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        name: 'Docs',
        url: 'https://mcp.example.com',
        transport: 'auto',
        authMode: 'auto',
        enabled: true,
        toolPermissions: {},
        tools: [],
        oauth: {
          authorizationUrl: 'https://as.example.com/authorize',
          tokenUrl: 'https://as.example.com/token',
          resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
          resource: 'https://mcp.example.com',
          issuer: 'https://as.example.com',
          clientId: 'client-old',
          expiresAt: new Date(),
          hasRefreshToken: true,
        },
        save: vi.fn(async () => undefined),
        markModified: vi.fn(),
      }
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(doc))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      vi.spyOn(ConnectorCredentialModel, 'updateOne').mockReturnValue(query({}))
      vi.spyOn(ConnectorService, 'connect').mockResolvedValue('authorize')

      await ConnectorService.update(CONNECTOR_ID, USER_ID, {
        url: 'https://other.example.com/mcp',
      })

      expect(doc.oauth.authorizationUrl).to.be.undefined
      expect(doc.oauth.tokenUrl).to.be.undefined
      expect(doc.oauth.resourceMetadataUrl).to.be.undefined
      expect(doc.oauth.resource).to.be.undefined
      expect(doc.oauth.issuer).to.be.undefined
    })

    function originDoc(oauth = {}) {
      return {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        name: 'Docs',
        url: 'https://mcp.example.com',
        transport: 'auto',
        authMode: 'auto',
        enabled: true,
        toolPermissions: {},
        tools: [],
        oauth: { clientMode: 'custom', customClientId: 'client-old', scopes: 'repo admin', ...oauth },
        save: vi.fn(async () => undefined),
        markModified: vi.fn(),
      }
    }

    function stubOriginChange(doc) {
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(doc))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      const updateOne = vi
        .spyOn(ConnectorCredentialModel, 'updateOne')
        .mockReturnValue(query({}))
      vi.spyOn(ConnectorService, 'connect').mockResolvedValue('authorize')
      return updateOne
    }

    it('clears the saved client secret and the discovered scopes when the origin changes', async function () {
      const doc = originDoc()
      const updateOne = stubOriginChange(doc)

      await ConnectorService.update(CONNECTOR_ID, USER_ID, {
        url: 'https://other.example.com/mcp',
      })

      const [, update] = updateOne.mock.calls[0]
      expect(update.$unset).to.include.keys('clientSecret')
      expect(update.$set).to.not.have.property('clientSecret')
      expect(doc.oauth.scopes).to.be.undefined
    })

    it('saves a client secret and scopes typed in the same PATCH as the new origin', async function () {
      const doc = originDoc()
      const updateOne = stubOriginChange(doc)

      await ConnectorService.update(CONNECTOR_ID, USER_ID, {
        url: 'https://other.example.com/mcp',
        oauth: { clientSecret: 'new-secret', scopes: 'calendar' },
      })

      const [, update] = updateOne.mock.calls[0]
      expect(update.$unset).to.not.have.property('clientSecret')
      const sealed = update.$set.clientSecret
      expect(
        open(sealed, `aiAssistConnectorCredentials:${CONNECTOR_ID}:clientSecret`)
      ).to.equal('new-secret')
      expect(doc.oauth.scopes).to.equal('calendar')
    })

    it('leaves the saved client secret and scopes alone when the origin does not change', async function () {
      const doc = originDoc()
      const updateOne = stubOriginChange(doc)

      await ConnectorService.update(CONNECTOR_ID, USER_ID, {
        url: 'https://mcp.example.com/v2',
      })

      expect(updateOne.mock.calls).to.have.lengthOf(0)
      expect(doc.oauth.scopes).to.equal('repo admin')
    })

    it('keeps the endpoints when only the path of the same origin changes', async function () {
      const doc = {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        name: 'Docs',
        url: 'https://mcp.example.com/v1',
        transport: 'auto',
        authMode: 'auto',
        enabled: true,
        toolPermissions: {},
        tools: [],
        oauth: { tokenUrl: 'https://as.example.com/token' },
        save: vi.fn(async () => undefined),
        markModified: vi.fn(),
      }
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(doc))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      vi.spyOn(ConnectorCredentialModel, 'updateOne').mockReturnValue(query({}))
      vi.spyOn(ConnectorService, 'connect').mockResolvedValue('connected')

      await ConnectorService.update(CONNECTOR_ID, USER_ID, {
        url: 'https://mcp.example.com/v2',
      })

      expect(doc.oauth.tokenUrl).to.equal('https://as.example.com/token')
    })

    it('asks for sign-in again, not for the credentials it cannot read', async function () {
      vi.spyOn(ConnectorModel.prototype, 'save').mockResolvedValue(undefined)
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(
        query({ connector_id: CONNECTOR_ID, tokens: 'v2:not-openable' })
      )
      vi.spyOn(ConnectorCredentialModel, 'updateOne').mockReturnValue({
        exec: async () => undefined,
      })
      vi.spyOn(ConnectorModel, 'updateOne').mockReturnValue({
        exec: async () => undefined,
      })
      vi.spyOn(ConnectorModel, 'findById').mockReturnValue(query(null))
      const connectSpy = vi.spyOn(McpClient.prototype, 'connect')
      const connector = {
        _id: CONNECTOR_ID,
        url: 'https://mcp.example.com',
        transport: 'auto',
        authMode: 'auto',
        oauth: {},
        save: vi.fn(async () => undefined),
      }

      const next = await ConnectorService.connect(connector)

      expect(next).to.equal('authorize')
      expect(connector.status).to.equal('needs_auth')
      expect(connector.save.mock.calls).to.have.lengthOf(1)
      expect(connectSpy.mock.calls).to.have.lengthOf(0)
    })
  })

  describe('authorize', function () {
    function ownedConnector(overrides = {}) {
      return {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        url: 'https://mcp.example.com',
        authMode: 'auto',
        status: 'needs_auth',
        oauth: {},
        save: vi.fn(async () => undefined),
        ...overrides,
      }
    }

    it('refuses to start a sign-in for a connector whose authentication is none', async function () {
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(
        query(ownedConnector({ authMode: 'none' }))
      )
      const start = vi.spyOn(ConnectorService, '_startSignIn')

      let error = null
      try {
        await ConnectorService.authorize(CONNECTOR_ID, USER_ID, {})
      } catch (err) {
        error = err
      }
      expect(error.status).to.equal(400)
      expect(error.message).to.match(/turned off/)
      expect(start.mock.calls).to.have.lengthOf(0)
    })

    it('sets the connector to error with the message when the sign-in cannot start', async function () {
      const connector = ownedConnector()
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(connector))
      vi.spyOn(ConnectorService, '_startSignIn').mockRejectedValue(
        new Error("This server's sign-in could not be discovered.")
      )

      let error = null
      try {
        await ConnectorService.authorize(CONNECTOR_ID, USER_ID, {})
      } catch (err) {
        error = err
      }
      expect(error.message).to.match(/could not be discovered/)
      expect(connector.status).to.equal('error')
      expect(connector.lastError.message).to.match(/could not be discovered/)
    })

    it('keeps a connected connector connected when a step-up cannot start', async function () {
      const connector = ownedConnector({ status: 'connected' })
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(connector))
      vi.spyOn(ConnectorService, '_startSignIn').mockRejectedValue(new Error('nope'))

      await ConnectorService.authorize(CONNECTOR_ID, USER_ID, { scope: 'calendar' })
        .catch(() => {})
      expect(connector.status).to.equal('connected')
    })

    it('returns the sign-in URL it started', async function () {
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(ownedConnector()))
      vi.spyOn(ConnectorService, '_startSignIn').mockResolvedValue({
        authorizationUrl: 'https://as.example.com/authorize?x=1',
      })

      const result = await ConnectorService.authorize(CONNECTOR_ID, USER_ID, {})
      expect(result.authorizationUrl).to.equal('https://as.example.com/authorize?x=1')
    })
  })

  describe('handleCallback', function () {
    const STATE = 'service-callback-state'
    const STATE_HASH = crypto.createHash('sha256').update(STATE).digest('hex')
    const CALLBACK_URL = 'https://overleaf.example.com/ai-assist/connectors/oauth/callback'

    function pendingSignIn() {
      return {
        stateHash: STATE_HASH,
        connector_id: CONNECTOR_ID,
        user_id: USER_ID,
        verifier: seal('verifier-x', `aiAssistOAuthStates:${STATE_HASH}:verifier`),
        redirectUri: CALLBACK_URL,
        clientId: 'client-123',
        scope: 'read',
        issuer: '',
        resource: '',
        expiresAt: new Date(Date.now() + 60_000),
      }
    }

    function tokenFetch() {
      const calls = []
      const fetch = async (url, options = {}) => {
        calls.push(url)
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'at-1', expires_in: 3600 }),
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        }
      }
      return { fetch, calls }
    }

    function stubCallbackStores(connector) {
      vi.spyOn(OAuthStateModel, 'findOneAndDelete').mockReturnValue(query(pendingSignIn()))
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(connector))
      vi.spyOn(ConnectorModel.prototype, 'save').mockResolvedValue(undefined)
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      vi.spyOn(ConnectorCredentialModel, 'updateOne').mockReturnValue({
        exec: async () => undefined,
      })
    }

    it('reports the connect result, so a failed follow-up connect is not a success', async function () {
      const connector = {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        url: 'https://mcp.example.com',
        status: 'pending',
        oauth: { tokenUrl: 'https://as.example.com/token' },
        save: vi.fn(async () => undefined),
        markModified: vi.fn(),
      }
      stubCallbackStores(connector)
      vi.spyOn(McpClient.prototype, 'connect').mockRejectedValue(
        new Error('Server unreachable after sign-in')
      )
      const { fetch } = tokenFetch()

      const result = await ConnectorService.handleCallback({
        code: 'c',
        state: STATE,
        userId: USER_ID,
        fetch,
      })

      expect(result.next).to.equal('error')
      expect(result.connector.status).to.equal('error')
      expect(result.connector.lastError.message).to.equal('Server unreachable after sign-in')
    })

    it('reports connected when the server accepts the new tokens', async function () {
      const connector = {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        url: 'https://mcp.example.com',
        status: 'pending',
        oauth: { tokenUrl: 'https://as.example.com/token' },
        save: vi.fn(async () => undefined),
        markModified: vi.fn(),
      }
      stubCallbackStores(connector)
      vi.spyOn(McpClient.prototype, 'connect').mockResolvedValue(undefined)
      vi.spyOn(McpClient.prototype, 'listTools').mockResolvedValue([])
      const { fetch } = tokenFetch()

      const result = await ConnectorService.handleCallback({
        code: 'c',
        state: STATE,
        userId: USER_ID,
        fetch,
      })

      expect(result.next).to.equal('connected')
      expect(result.connector.status).to.equal('connected')
    })

    it('finds the connector a state belongs to without consuming it', async function () {
      const find = vi
        .spyOn(OAuthStateModel, 'findOne')
        .mockReturnValue(query(pendingSignIn()))
      const consume = vi.spyOn(OAuthStateModel, 'findOneAndDelete')

      const id = await ConnectorService.pendingConnectorId({
        state: STATE,
        userId: USER_ID,
      })

      expect(id).to.equal(CONNECTOR_ID)
      expect(find.mock.calls[0][0]).to.deep.include({ user_id: USER_ID })
      expect(consume.mock.calls).to.have.lengthOf(0)
    })
  })
})
