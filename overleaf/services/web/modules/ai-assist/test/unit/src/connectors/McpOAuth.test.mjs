import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { expect } from 'chai'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import {
  discoverProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  resolveClient,
  startAuthorization,
  handleCallback,
  signInOffered,
  pendingConnectorId,
  currentAccessToken,
  refreshTokens,
  clientMetadataUrl,
  OAuthClientRequiredError,
} from '../../../../app/src/connectors/McpOAuth.mjs'
import {
  ConnectorModel,
  ConnectorCredentialModel,
  OAuthClientModel,
  OAuthStateModel,
} from '../../../../app/src/connectors/ConnectorModel.mjs'
import { open, seal } from '../../../../app/src/connectors/ConnectorCrypto.mjs'

const CONNECTOR_ID = '507f1f77bcf86cd799439011'
const USER_ID = '607f1f77bcf86cd799439099'
const SECRET = 'mcp-oauth-test-session-secret-0123456789'
const CALLBACK = 'https://overleaf.example.com/ai-assist/connectors/oauth/callback'

function query(result) {
  const q = { sort: () => q, lean: () => q, exec: async () => result }
  return q
}

// Answers fetch from a map of URL -> { status, body }; anything else is a 404
function respondWith(map = {}) {
  const calls = []
  const fetch = async (url, options = {}) => {
    calls.push({ url, options })
    const reply = map[url]
    if (!reply) {
      return { ok: false, status: 404, text: async () => '', json: async () => null }
    }
    const status = reply.status ?? 200
    const body =
      typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    }
  }
  return { fetch, calls }
}

const AS_METADATA = {
  issuer: 'https://as.example.com',
  authorization_endpoint: 'https://as.example.com/authorize',
  token_endpoint: 'https://as.example.com/token',
  registration_endpoint: 'https://as.example.com/register',
  code_challenge_methods_supported: ['S256'],
}

describe('McpOAuth', function () {
  const originalSecurity = Settings.security
  const originalSiteUrl = Settings.siteUrl

  beforeEach(function () {
    Settings.security = { sessionSecret: SECRET }
    Settings.siteUrl = 'https://overleaf.example.com'
  })

  afterEach(function () {
    vi.restoreAllMocks()
    Settings.security = originalSecurity
    Settings.siteUrl = originalSiteUrl
  })

  describe('discoverProtectedResourceMetadata', function () {
    it('fetches metadata directly from resourceMetadataUrl when present', async function () {
      const { fetch } = respondWith({
        'https://auth.example.com/prm.json': {
          body: {
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://as.example.com'],
            scopes_supported: ['read', 'write'],
          },
        },
      })

      const meta = await discoverProtectedResourceMetadata({
        url: 'https://mcp.example.com/api',
        resourceMetadataUrl: 'https://auth.example.com/prm.json',
        fetch,
      })

      expect(meta.resource).to.equal('https://mcp.example.com')
      expect(meta.authorization_servers).to.deep.equal(['https://as.example.com'])
      expect(meta.scopes_supported).to.deep.equal(['read', 'write'])
    })

    it('falls back to the path-aware, then the root well-known document', async function () {
      const { fetch, calls } = respondWith({
        'https://mcp.example.com/.well-known/oauth-protected-resource/v1': {
          body: {
            resource: 'https://mcp.example.com/v1',
            authorization_servers: ['https://as.example.com/oauth'],
          },
        },
      })

      const meta = await discoverProtectedResourceMetadata({
        url: 'https://mcp.example.com/v1',
        fetch,
      })

      expect(calls.map(c => c.url)).to.deep.equal([
        'https://mcp.example.com/.well-known/oauth-protected-resource/v1',
      ])
      expect(meta.resource).to.equal('https://mcp.example.com/v1')
      expect(meta.authorization_servers).to.deep.equal(['https://as.example.com/oauth'])
    })

    it('returns the server itself as the resource, with no authorization server, when nothing is published', async function () {
      const { fetch } = respondWith({})

      const meta = await discoverProtectedResourceMetadata({
        url: 'https://mcp.example.com/v1',
        fetch,
      })

      expect(meta).to.deep.equal({
        resource: 'https://mcp.example.com/v1',
        authorization_servers: [],
        scopes_supported: [],
        raw: null,
      })
    })
  })

  describe('discoverAuthorizationServerMetadata', function () {
    it('reads RFC 8414 metadata and fills in the defaults for what it leaves out', async function () {
      const { fetch } = respondWith({
        'https://as.example.com/.well-known/oauth-authorization-server': {
          body: AS_METADATA,
        },
      })

      const as = await discoverAuthorizationServerMetadata({
        issuer: 'https://as.example.com',
        fetch,
      })

      expect(as.issuer).to.equal('https://as.example.com')
      expect(as.authorization_endpoint).to.equal('https://as.example.com/authorize')
      expect(as.token_endpoint).to.equal('https://as.example.com/token')
      expect(as.registration_endpoint).to.equal('https://as.example.com/register')
      expect(as.token_endpoint_auth_methods_supported).to.deep.equal([
        'client_secret_basic',
      ])
      expect(as.client_id_metadata_document_supported).to.be.false
    })

    it('drops an endpoint that is not a web address, so no javascript: link reaches the browser', async function () {
      const { fetch } = respondWith({
        'https://as.example.com/.well-known/oauth-authorization-server': {
          body: {
            ...AS_METADATA,
            authorization_endpoint: 'javascript:alert(document.cookie)',
          },
        },
      })

      const as = await discoverAuthorizationServerMetadata({
        issuer: 'https://as.example.com',
        fetch,
      })

      expect(as.authorization_endpoint).to.be.undefined
      expect(as.token_endpoint).to.equal('https://as.example.com/token')
    })

    it('for an issuer with a path, tries the path-aware documents in the spec order', async function () {
      const { fetch, calls } = respondWith({
        'https://as.example.com/tenant/.well-known/openid-configuration': {
          body: { ...AS_METADATA, issuer: 'https://as.example.com/tenant' },
        },
      })

      const as = await discoverAuthorizationServerMetadata({
        issuer: 'https://as.example.com/tenant',
        fetch,
      })

      expect(calls.map(c => c.url)).to.deep.equal([
        'https://as.example.com/.well-known/oauth-authorization-server/tenant',
        'https://as.example.com/.well-known/openid-configuration/tenant',
        'https://as.example.com/tenant/.well-known/openid-configuration',
      ])
      expect(as.issuer).to.equal('https://as.example.com/tenant')
    })

    it('throws when no metadata document can be found', async function () {
      const { fetch } = respondWith({})

      let error = null
      try {
        await discoverAuthorizationServerMetadata({
          issuer: 'https://as.example.com',
          fetch,
        })
      } catch (err) {
        error = err
      }
      expect(error.message).to.match(/Failed to discover OAuth authorization server metadata/)
    })
  })

  describe('resolveClient', function () {
    const publicAs = {
      ...AS_METADATA,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none'],
    }

    it('uses the custom client the user entered', async function () {
      const reg = await resolveClient({
        connector: { oauth: { clientMode: 'custom', customClientId: 'my-client' } },
        as: AS_METADATA,
      })

      expect(reg).to.deep.equal({ clientId: 'my-client', registration: 'custom' })
    })

    it('asks for a custom client when custom is chosen but no ID was entered', async function () {
      let error = null
      try {
        await resolveClient({
          connector: { oauth: { clientMode: 'custom' } },
          as: AS_METADATA,
        })
      } catch (err) {
        error = err
      }
      expect(error).to.be.instanceOf(OAuthClientRequiredError)
      expect(error.code).to.equal('OAUTH_CLIENT_REQUIRED')
      expect(error.status).to.equal(400)
    })

    it('uses the published client metadata document on a public https site when the server accepts it', async function () {
      const reg = await resolveClient({
        connector: { oauth: { clientMode: 'auto' } },
        as: publicAs,
      })

      expect(reg.registration).to.equal('cimd')
      expect(reg.clientId).to.equal(clientMetadataUrl())
      expect(reg.clientId).to.equal(
        'https://overleaf.example.com/ai-assist/connectors/oauth/client-metadata.json'
      )
    })

    it('does not offer the metadata document from a private site, and registers instead', async function () {
      Settings.siteUrl = 'http://localhost:8080'
      vi.spyOn(OAuthClientModel, 'findOne').mockReturnValue(query(null))
      const updateOne = vi
        .spyOn(OAuthClientModel, 'updateOne')
        .mockReturnValue({ exec: async () => undefined })
      const { fetch, calls } = respondWith({
        'https://as.example.com/register': {
          status: 201,
          body: { client_id: 'dcr-client-1' },
        },
      })

      const reg = await resolveClient({
        connector: { oauth: { clientMode: 'auto' } },
        as: publicAs,
        fetch,
      })

      expect(reg).to.deep.equal({ clientId: 'dcr-client-1', registration: 'dcr' })
      expect(calls).to.have.lengthOf(1)
      const body = JSON.parse(calls[0].options.body)
      expect(body.redirect_uris).to.deep.equal(['http://localhost:8080/ai-assist/connectors/oauth/callback'])
      expect(body.token_endpoint_auth_method).to.equal('none')
      expect(updateOne.mock.calls[0][0]).to.deep.equal({
        issuer: 'https://as.example.com',
        redirectUri: 'http://localhost:8080/ai-assist/connectors/oauth/callback',
      })
    })

    it('reuses the client registered earlier with the same server, without registering again', async function () {
      vi.spyOn(OAuthClientModel, 'findOne').mockReturnValue(
        query({ issuer: AS_METADATA.issuer, clientId: 'shared-client' })
      )
      const { fetch, calls } = respondWith({})

      const reg = await resolveClient({
        connector: { oauth: { clientMode: 'auto' } },
        as: AS_METADATA,
        fetch,
      })

      expect(reg).to.deep.equal({ clientId: 'shared-client', registration: 'dcr' })
      expect(calls).to.have.lengthOf(0)
    })

    it('registers again when the shared client secret has expired', async function () {
      vi.spyOn(OAuthClientModel, 'findOne').mockReturnValue(
        query({
          issuer: AS_METADATA.issuer,
          clientId: 'old-client',
          secretExpiresAt: new Date(Date.now() - 60_000),
        })
      )
      vi.spyOn(OAuthClientModel, 'updateOne').mockReturnValue({
        exec: async () => undefined,
      })
      const { fetch, calls } = respondWith({
        'https://as.example.com/register': {
          status: 201,
          body: { client_id: 'fresh-client' },
        },
      })

      const reg = await resolveClient({
        connector: { oauth: { clientMode: 'auto' } },
        as: AS_METADATA,
        fetch,
      })

      expect(reg.clientId).to.equal('fresh-client')
      expect(calls).to.have.lengthOf(1)
    })

    it('asks for a client when the server offers neither metadata documents nor registration', async function () {
      let error = null
      try {
        await resolveClient({
          connector: { oauth: { clientMode: 'auto' } },
          as: { ...AS_METADATA, registration_endpoint: undefined },
        })
      } catch (err) {
        error = err
      }
      expect(error).to.be.instanceOf(OAuthClientRequiredError)
    })
  })

  describe('startAuthorization', function () {
    function connectorFor(overrides = {}) {
      return {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        url: 'https://mcp.example.com/api',
        oauth: {
          clientMode: 'custom',
          customClientId: 'client-123',
          authorizationUrl: 'https://as.example.com/authorize',
          tokenUrl: 'https://as.example.com/token',
        },
        save: vi.fn(async () => undefined),
        ...overrides,
      }
    }

    it('refuses a sign-in address that is not http or https, before anything is stored', async function () {
      const create = vi.spyOn(OAuthStateModel, 'create').mockResolvedValue({})
      const { fetch } = respondWith({})
      const connector = connectorFor({
        oauth: {
          clientMode: 'custom',
          customClientId: 'client-123',
          authorizationUrl: 'javascript:alert(1)',
          tokenUrl: 'https://as.example.com/token',
        },
      })

      let error = null
      try {
        await startAuthorization({ connector, fetch })
      } catch (err) {
        error = err
      }
      expect(error?.message).to.match(/not a web \(http or https\) address/)
      expect(create.mock.calls).to.have.length(0)
    })

    it('builds a PKCE S256 sign-in URL and stores only a hash of the state and a sealed verifier', async function () {
      vi.spyOn(OAuthStateModel, 'create').mockResolvedValue({})
      const { fetch } = respondWith({})

      const { authorizationUrl } = await startAuthorization({
        connector: connectorFor(),
        fetch,
      })

      const url = new URL(authorizationUrl)
      expect(url.origin + url.pathname).to.equal('https://as.example.com/authorize')
      expect(url.searchParams.get('response_type')).to.equal('code')
      expect(url.searchParams.get('client_id')).to.equal('client-123')
      expect(url.searchParams.get('redirect_uri')).to.equal(CALLBACK)
      expect(url.searchParams.get('code_challenge_method')).to.equal('S256')
      expect(url.searchParams.get('resource')).to.equal('https://mcp.example.com/api')

      const state = url.searchParams.get('state')
      const stored = OAuthStateModel.create.mock.calls[0][0]
      const stateHash = crypto.createHash('sha256').update(state).digest('hex')
      expect(stored.stateHash).to.equal(stateHash)
      expect(stored.verifier).to.not.include(state)

      // The challenge is the S256 of the verifier that was sealed with the state
      const verifier = open(
        stored.verifier,
        `aiAssistOAuthStates:${stateHash}:verifier`
      )
      const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url')
      expect(url.searchParams.get('code_challenge')).to.equal(challenge)
    })

    it('asks a Google connector without its own client for one, rather than guessing', async function () {
      vi.spyOn(OAuthStateModel, 'create').mockResolvedValue({})
      const { fetch } = respondWith({})

      let error = null
      try {
        await startAuthorization({
          connector: connectorFor({
            url: 'https://calendar.googleapis.com/mcp',
            oauth: { clientMode: 'custom' },
          }),
          fetch,
        })
      } catch (err) {
        error = err
      }
      expect(error.code).to.equal('OAUTH_CLIENT_REQUIRED')
      expect(OAuthStateModel.create.mock.calls).to.have.lengthOf(0)
    })

    it('adds Google offline access and consent, and sends no resource indicator to Google', async function () {
      vi.spyOn(OAuthStateModel, 'create').mockResolvedValue({})
      const { fetch } = respondWith({})

      const { authorizationUrl } = await startAuthorization({
        connector: connectorFor({
          url: 'https://calendar.googleapis.com/mcp',
          oauth: {
            clientMode: 'custom',
            customClientId: 'google-client',
            scopes: 'https://www.googleapis.com/auth/calendar.readonly',
          },
        }),
        fetch,
      })

      const url = new URL(authorizationUrl)
      expect(url.origin).to.equal('https://accounts.google.com')
      expect(url.searchParams.get('access_type')).to.equal('offline')
      expect(url.searchParams.get('prompt')).to.equal('consent')
      expect(url.searchParams.get('scope')).to.include(
        'https://www.googleapis.com/auth/calendar.readonly'
      )
      expect(url.searchParams.has('resource')).to.be.false
    })
  })

  describe('handleCallback', function () {
    const STATE = 'state-from-the-redirect'
    const STATE_HASH = crypto.createHash('sha256').update(STATE).digest('hex')
    const VERIFIER = 'verifier-that-was-sealed'

    function pendingSignIn(overrides = {}) {
      return {
        stateHash: STATE_HASH,
        connector_id: CONNECTOR_ID,
        user_id: USER_ID,
        verifier: seal(VERIFIER, `aiAssistOAuthStates:${STATE_HASH}:verifier`),
        redirectUri: CALLBACK,
        clientId: 'client-123',
        scope: 'read',
        issuer: 'https://as.example.com',
        resource: 'https://mcp.example.com/api',
        expiresAt: new Date(Date.now() + 60_000),
        ...overrides,
      }
    }

    it('refuses a callback whose state is unknown or was already used', async function () {
      vi.spyOn(OAuthStateModel, 'findOneAndDelete').mockReturnValue(query(null))

      let error = null
      try {
        await handleCallback({ code: 'c', state: STATE, userId: USER_ID })
      } catch (err) {
        error = err
      }
      expect(error.message).to.match(/already used, has expired/)
    })

    it('only consumes a sign-in started by the same account', async function () {
      const spy = vi
        .spyOn(OAuthStateModel, 'findOneAndDelete')
        .mockReturnValue(query(null))

      let error = null
      try {
        await handleCallback({ code: 'c', state: STATE, userId: USER_ID })
      } catch (err) {
        error = err
      }
      expect(spy.mock.calls[0][0]).to.deep.include({ user_id: USER_ID })
      expect(error.message).to.match(/belongs to another account/)
    })

    it('refuses an issuer that does not match the one the sign-in started with', async function () {
      vi.spyOn(OAuthStateModel, 'findOneAndDelete').mockReturnValue(query(pendingSignIn()))

      let error = null
      try {
        await handleCallback({
          code: 'c',
          state: STATE,
          iss: 'https://evil.example.com',
          userId: USER_ID,
        })
      } catch (err) {
        error = err
      }
      expect(error.message).to.match(/Issuer mismatch/)
    })

    it('exchanges the code with the verifier and stores the tokens sealed, marking the connector connected', async function () {
      vi.spyOn(OAuthStateModel, 'findOneAndDelete').mockReturnValue(query(pendingSignIn()))
      const connector = {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        oauth: { tokenUrl: 'https://as.example.com/token', resource: 'https://mcp.example.com/api' },
        save: vi.fn(async () => undefined),
      }
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(connector))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      const updateOne = vi
        .spyOn(ConnectorCredentialModel, 'updateOne')
        .mockReturnValue({ exec: async () => undefined })
      const { fetch, calls } = respondWith({
        'https://as.example.com/token': {
          body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'read' },
        },
      })

      const result = await handleCallback({
        code: 'auth-code',
        state: STATE,
        iss: 'https://as.example.com',
        userId: USER_ID,
        fetch,
      })

      const form = new URLSearchParams(calls[0].options.body)
      expect(form.get('grant_type')).to.equal('authorization_code')
      expect(form.get('code')).to.equal('auth-code')
      expect(form.get('code_verifier')).to.equal(VERIFIER)
      expect(form.get('redirect_uri')).to.equal(CALLBACK)
      expect(form.get('client_id')).to.equal('client-123')

      const sealedTokens = updateOne.mock.calls[0][1].$set.tokens
      expect(sealedTokens).to.not.include('at-1')
      expect(open(sealedTokens, `aiAssistConnectorCredentials:${CONNECTOR_ID}:tokens`))
        .to.include({ access_token: 'at-1', refresh_token: 'rt-1' })

      expect(result.connector.status).to.equal('connected')
      expect(connector.oauth.hasRefreshToken).to.be.true
      expect(connector.save.mock.calls).to.have.lengthOf(1)
    })
  })

  describe('currentAccessToken and refreshTokens', function () {
    const TOKENS_CONTEXT = `aiAssistConnectorCredentials:${CONNECTOR_ID}:tokens`

    function connectorExpiringIn(ms) {
      return {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        url: 'https://mcp.example.com/api',
        oauth: {
          clientId: 'client-123',
          tokenUrl: 'https://as.example.com/token',
          expiresAt: new Date(Date.now() + ms),
          hasRefreshToken: true,
        },
        status: 'connected',
        save: vi.fn(async () => undefined),
      }
    }

    function storedTokens(tokens) {
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(
        query({ tokens: seal(tokens, TOKENS_CONTEXT) })
      )
      // The renewal lease is free unless a test says otherwise
      vi.spyOn(ConnectorModel, 'findOneAndUpdate').mockReturnValue(
        query({ _id: CONNECTOR_ID })
      )
      vi.spyOn(ConnectorModel, 'updateOne').mockReturnValue({
        exec: async () => undefined,
      })
      return vi
        .spyOn(ConnectorCredentialModel, 'updateOne')
        .mockReturnValue({ exec: async () => undefined })
    }

    it('returns the saved access token without a request while it is not near expiry', async function () {
      const { fetch, calls } = respondWith({})

      const token = await currentAccessToken({
        connector: connectorExpiringIn(60 * 60 * 1000),
        credentials: { tokens: { access_token: 'at-live', refresh_token: 'rt' } },
        fetch,
      })

      expect(token).to.equal('at-live')
      expect(calls).to.have.lengthOf(0)
    })

    it('returns null when the connector has no access token', async function () {
      const token = await currentAccessToken({
        connector: connectorExpiringIn(60 * 60 * 1000),
        credentials: { tokens: null },
      })

      expect(token).to.be.null
    })

    it('refreshes inside the five-minute window and keeps the refresh token it was not given a new one for', async function () {
      const updateOne = storedTokens({ access_token: 'old', refresh_token: 'rt-old' })
      const connector = connectorExpiringIn(2 * 60 * 1000)
      const { fetch, calls } = respondWith({
        'https://as.example.com/token': {
          body: { access_token: 'new', expires_in: 3600 },
        },
      })

      const token = await currentAccessToken({
        connector,
        credentials: { tokens: { access_token: 'old', refresh_token: 'rt-old' } },
        fetch,
      })

      expect(token).to.equal('new')
      const form = new URLSearchParams(calls[0].options.body)
      expect(form.get('grant_type')).to.equal('refresh_token')
      expect(form.get('refresh_token')).to.equal('rt-old')
      const saved = open(updateOne.mock.calls[0][1].$set.tokens, TOKENS_CONTEXT)
      expect(saved).to.include({ access_token: 'new', refresh_token: 'rt-old' })
      expect(connector.status).to.equal('connected')
    })

    it('takes the renewal lease for the request and releases it when the renewal ends', async function () {
      storedTokens({ access_token: 'old', refresh_token: 'rt-old' })
      const lease = ConnectorModel.findOneAndUpdate
      const release = ConnectorModel.updateOne
      const connector = connectorExpiringIn(60 * 1000)
      const { fetch } = respondWith({
        'https://as.example.com/token': {
          body: { access_token: 'new', expires_in: 3600 },
        },
      })

      await refreshTokens({ connector, fetch })

      expect(lease.mock.calls[0][1].$set.refreshLockUntil).to.be.instanceOf(Date)
      const [filter, update] = release.mock.calls[0]
      expect(filter.refreshLockUntil).to.be.instanceOf(Date)
      expect(update).to.deep.equal({ $unset: { refreshLockUntil: '' } })
    })

    it('waits for a renewal another replica is running, and uses the token it stores', async function () {
      storedTokens({ access_token: 'old', refresh_token: 'rt-old' })
      vi.spyOn(ConnectorModel, 'findOneAndUpdate').mockReturnValue(query(null))
      vi.spyOn(ConnectorCredentialModel, 'findOne')
        .mockReturnValueOnce(
          query({ tokens: seal({ access_token: 'old', refresh_token: 'rt-old' }, TOKENS_CONTEXT) })
        )
        .mockReturnValue(
          query({ tokens: seal({ access_token: 'from-other', refresh_token: 'rt-new' }, TOKENS_CONTEXT) })
        )
      const connector = connectorExpiringIn(60 * 1000)
      const { fetch, calls } = respondWith({})

      const token = await refreshTokens({ connector, fetch })

      expect(token).to.equal('from-other')
      expect(calls).to.have.lengthOf(0)
    })

    it('does not sign the connector out when the refresh token it sent was rotated by another replica', async function () {
      const updateOne = storedTokens({ access_token: 'old', refresh_token: 'rt-old' })
      vi.spyOn(ConnectorCredentialModel, 'findOne')
        .mockReturnValueOnce(
          query({ tokens: seal({ access_token: 'old', refresh_token: 'rt-old' }, TOKENS_CONTEXT) })
        )
        .mockReturnValueOnce(
          query({ tokens: seal({ access_token: 'old', refresh_token: 'rt-old' }, TOKENS_CONTEXT) })
        )
        .mockReturnValue(
          query({ tokens: seal({ access_token: 'rotated-at', refresh_token: 'rt-new' }, TOKENS_CONTEXT) })
        )
      const connector = connectorExpiringIn(60 * 1000)
      const { fetch } = respondWith({
        'https://as.example.com/token': {
          status: 400,
          body: { error: 'invalid_grant' },
        },
      })

      const token = await refreshTokens({ connector, fetch })

      expect(token).to.equal('rotated-at')
      expect(connector.status).to.equal('connected')
      expect(
        updateOne.mock.calls.some(([, update]) => update.$unset?.tokens !== undefined)
      ).to.be.false
    })

    it('sends one refresh request for concurrent callers, so a rotating refresh token is spent once', async function () {
      storedTokens({ access_token: 'old', refresh_token: 'rt-old' })
      const connector = connectorExpiringIn(60 * 1000)
      const { fetch, calls } = respondWith({
        'https://as.example.com/token': {
          body: { access_token: 'new', refresh_token: 'rt-new', expires_in: 3600 },
        },
      })
      const credentials = { tokens: { access_token: 'old', refresh_token: 'rt-old' } }

      const tokens = await Promise.all([
        currentAccessToken({ connector, credentials, fetch }),
        currentAccessToken({ connector, credentials, fetch }),
        refreshTokens({ connector, fetch }),
      ])

      expect(tokens).to.deep.equal(['new', 'new', 'new'])
      expect(calls).to.have.lengthOf(1)
    })

    it('clears the saved tokens and asks for sign-in when the refresh token is rejected', async function () {
      const updateOne = storedTokens({ access_token: 'old', refresh_token: 'rt-revoked' })
      const connector = connectorExpiringIn(60 * 1000)
      const { fetch } = respondWith({
        'https://as.example.com/token': {
          status: 400,
          body: { error: 'invalid_grant', error_description: 'Refresh token revoked' },
        },
      })

      let error = null
      try {
        await refreshTokens({ connector, fetch })
      } catch (err) {
        error = err
      }

      expect(error.code).to.equal('invalid_grant')
      expect(connector.status).to.equal('needs_auth')
      expect(connector.oauth.hasRefreshToken).to.be.false
      expect(updateOne.mock.calls[0][1].$unset).to.have.property('tokens')
    })

    it('keeps the current access token when a refresh fails for another reason', async function () {
      const updateOne = storedTokens({ access_token: 'old', refresh_token: 'rt' })
      const connector = connectorExpiringIn(60 * 1000)
      const { fetch } = respondWith({
        'https://as.example.com/token': { status: 500, body: 'oops' },
      })

      const token = await currentAccessToken({
        connector,
        credentials: { tokens: { access_token: 'old', refresh_token: 'rt' } },
        fetch,
      })

      expect(token).to.equal('old')
      expect(connector.status).to.not.equal('needs_auth')
      expect(updateOne.mock.calls).to.have.lengthOf(0)
    })
  })

  describe('discovered endpoints', function () {
    const NEW_PRM = 'https://new.example.com/.well-known/oauth-protected-resource'
    const NEW_AS = {
      issuer: 'https://as2.example.com',
      authorization_endpoint: 'https://as2.example.com/authorize',
      token_endpoint: 'https://as2.example.com/token',
    }

    it('signs in with the endpoints discovered for a new origin, never the ones saved for the old one', async function () {
      vi.spyOn(OAuthStateModel, 'create').mockResolvedValue({})
      const { fetch } = respondWith({
        [NEW_PRM]: { body: { resource: 'https://new.example.com/mcp', authorization_servers: ['https://as2.example.com'] } },
        'https://as2.example.com/.well-known/oauth-authorization-server': { body: NEW_AS },
      })
      const connector = {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        url: 'https://new.example.com/mcp',
        oauth: { clientMode: 'custom', customClientId: 'client-123' },
        save: vi.fn(async () => undefined),
      }

      const { authorizationUrl } = await startAuthorization({ connector, fetch })

      const url = new URL(authorizationUrl)
      expect(url.origin).to.equal('https://as2.example.com')
      expect(url.pathname).to.equal('/authorize')
      // Discovery is used for this sign-in only; nothing is saved as an override
      expect(connector.oauth.authorizationUrl).to.be.undefined
      expect(connector.oauth.tokenUrl).to.be.undefined
    })

    it('keeps an endpoint the user entered in the advanced settings', async function () {
      vi.spyOn(OAuthStateModel, 'create').mockResolvedValue({})
      const { fetch } = respondWith({
        [NEW_PRM]: { body: { resource: 'https://new.example.com/mcp', authorization_servers: ['https://as2.example.com'] } },
        'https://as2.example.com/.well-known/oauth-authorization-server': { body: NEW_AS },
      })
      const connector = {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        url: 'https://new.example.com/mcp',
        oauth: {
          clientMode: 'custom',
          customClientId: 'client-123',
          authorizationUrl: 'https://manual.example.com/authorize',
        },
        save: vi.fn(async () => undefined),
      }

      const { authorizationUrl } = await startAuthorization({ connector, fetch })

      expect(new URL(authorizationUrl).origin).to.equal('https://manual.example.com')
      expect(connector.oauth.authorizationUrl).to.equal('https://manual.example.com/authorize')
      expect(connector.oauth.tokenUrl).to.be.undefined
    })

    it('reports that sign-in is offered only when endpoints exist', async function () {
      const manual = {
        url: 'https://plain.example.com/mcp',
        oauth: {
          authorizationUrl: 'https://as.example.com/authorize',
          tokenUrl: 'https://as.example.com/token',
        },
      }
      expect(await signInOffered({ connector: manual, fetch: respondWith({}).fetch })).to.be.true

      const discovered = {
        url: 'https://new.example.com/mcp',
        oauth: {},
      }
      const found = respondWith({
        [NEW_PRM]: { body: { resource: 'https://new.example.com/mcp', authorization_servers: ['https://as2.example.com'] } },
        'https://as2.example.com/.well-known/oauth-authorization-server': { body: NEW_AS },
      })
      expect(await signInOffered({ connector: discovered, fetch: found.fetch })).to.be.true

      const bare = { url: 'https://apikey.example.com/mcp', oauth: {} }
      expect(await signInOffered({ connector: bare, fetch: respondWith({}).fetch })).to.be.false
    })

    it('finds the connector a state belongs to without consuming the state', async function () {
      const state = 'lookup-state'
      const hash = crypto.createHash('sha256').update(state).digest('hex')
      const find = vi
        .spyOn(OAuthStateModel, 'findOne')
        .mockReturnValue(query({ stateHash: hash, connector_id: CONNECTOR_ID }))
      const consume = vi.spyOn(OAuthStateModel, 'findOneAndDelete')

      const id = await pendingConnectorId({ state, userId: USER_ID })

      expect(id).to.equal(CONNECTOR_ID)
      expect(find.mock.calls[0][0]).to.deep.equal({ stateHash: hash, user_id: USER_ID })
      expect(consume.mock.calls).to.have.lengthOf(0)
    })

    it('finds no connector for an unknown state', async function () {
      vi.spyOn(OAuthStateModel, 'findOne').mockReturnValue(query(null))
      expect(await pendingConnectorId({ state: 'nope', userId: USER_ID })).to.equal('')
      expect(await pendingConnectorId({ state: '', userId: USER_ID })).to.equal('')
    })
  })

  describe('callback and refresh token endpoints', function () {
    const STATE = 'discovered-callback-state'
    const STATE_HASH = crypto.createHash('sha256').update(STATE).digest('hex')
    const PRM_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource'
    const TOKENS_CONTEXT = `aiAssistConnectorCredentials:${CONNECTOR_ID}:tokens`

    function pending() {
      return {
        stateHash: STATE_HASH,
        connector_id: CONNECTOR_ID,
        user_id: USER_ID,
        verifier: seal('v', `aiAssistOAuthStates:${STATE_HASH}:verifier`),
        redirectUri: CALLBACK,
        clientId: 'client-123',
        scope: 'read',
        issuer: 'https://as.example.com',
        resource: '',
        expiresAt: new Date(Date.now() + 60_000),
      }
    }

    function stubConnector(oauth) {
      const connector = {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        url: 'https://mcp.example.com/api',
        oauth,
        save: vi.fn(async () => undefined),
      }
      vi.spyOn(OAuthStateModel, 'findOneAndDelete').mockReturnValue(query(pending()))
      vi.spyOn(ConnectorModel, 'findOne').mockReturnValue(query(connector))
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(query(null))
      const updateOne = vi
        .spyOn(ConnectorCredentialModel, 'updateOne')
        .mockReturnValue({ exec: async () => undefined })
      return { connector, updateOne }
    }

    it('sends the code to the token endpoint discovered now when no URL is saved', async function () {
      const { connector } = stubConnector({})
      const { fetch, calls } = respondWith({
        [PRM_URL]: { body: { resource: 'https://mcp.example.com', authorization_servers: ['https://as.example.com'] } },
        'https://as.example.com/.well-known/oauth-authorization-server': { body: AS_METADATA },
        'https://as.example.com/token': { body: { access_token: 'at', expires_in: 60 } },
      })

      await handleCallback({ code: 'c', state: STATE, iss: 'https://as.example.com', userId: USER_ID, fetch })

      const tokenCall = calls.find(c => c.url === 'https://as.example.com/token')
      expect(tokenCall).to.exist
      expect(connector.oauth.tokenUrl).to.be.undefined
      expect(connector.status).to.equal('connected')
    })

    it('refuses to send the code when the issuer metadata now names a different authorization server', async function () {
      stubConnector({})
      // The metadata of the issuer the sign-in started with now names another one
      const { fetch, calls } = respondWith({
        'https://as.example.com/.well-known/oauth-authorization-server': {
          body: { ...AS_METADATA, issuer: 'https://evil.example.com', token_endpoint: 'https://evil.example.com/token' },
        },
      })

      let error = null
      try {
        await handleCallback({ code: 'c', state: STATE, userId: USER_ID, fetch })
      } catch (err) {
        error = err
      }
      expect(error.message).to.match(/Issuer mismatch/)
      expect(calls.find(c => c.url === 'https://evil.example.com/token')).to.be.undefined
    })

    it('refreshes at the token endpoint the tokens were issued by when no URL is saved', async function () {
      const updateOne = vi
        .spyOn(ConnectorCredentialModel, 'updateOne')
        .mockReturnValue({ exec: async () => undefined })
      vi.spyOn(ConnectorModel, 'findOneAndUpdate').mockReturnValue(query({ _id: CONNECTOR_ID }))
      vi.spyOn(ConnectorModel, 'updateOne').mockReturnValue({ exec: async () => undefined })
      const connector = {
        _id: CONNECTOR_ID,
        user_id: USER_ID,
        oauth: { expiresAt: new Date(Date.now() + 60_000) },
        save: vi.fn(async () => undefined),
      }
      const tokens = {
        access_token: 'old',
        refresh_token: 'rt-1',
        token_endpoint: 'https://as.example.com/token',
      }
      vi.spyOn(ConnectorCredentialModel, 'findOne').mockReturnValue(
        query({ connector_id: CONNECTOR_ID, tokens: seal(tokens, TOKENS_CONTEXT) })
      )
      const { fetch, calls } = respondWith({
        'https://as.example.com/token': { body: { access_token: 'new', expires_in: 3600 } },
      })

      const token = await refreshTokens({ connector, fetch })

      expect(token).to.equal('new')
      expect(calls[0].url).to.equal('https://as.example.com/token')
      expect(updateOne.mock.calls).to.have.lengthOf(1)
    })
  })
})
