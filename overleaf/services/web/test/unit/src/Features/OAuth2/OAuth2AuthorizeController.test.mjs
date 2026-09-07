import { describe, it, vi, beforeEach } from 'vitest'
import { expect } from 'chai'
import OAuth2AuthorizeController from '../../../../../app/src/Features/OAuth2/OAuth2AuthorizeController.mjs'
import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import { OauthApplication } from '../../../../../app/src/models/OauthApplication.mjs'
import { OauthAuthorizationCode } from '../../../../../app/src/models/OauthAuthorizationCode.mjs'
import Settings from '@overleaf/settings'

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    renderedView: null,
    renderedData: null,
    redirectUrl: null,
    responseData: null,
    status(s) {
      this.statusCode = s
      return this
    },
    setHeader(k, v) {
      this.headers[k] = v
      return this
    },
    json(data) {
      this.responseData = data
      return this
    },
    render(view, data) {
      this.renderedView = view
      this.renderedData = data
      return this
    },
    redirect(url) {
      this.redirectUrl = url
      return this
    },
  }
  return res
}

describe('OAuth2AuthorizeController', () => {
  const dummyUser = {
    _id: '507f1f77bcf86cd799439011',
    email: 'test@example.com',
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    Settings.siteUrl = 'http://localhost:3000'
    // There are no pre-trusted client ids any more: every client is a row
    // created by dynamic client registration, so the lookup must be mocked.
    vi.spyOn(OauthApplication, 'findOne').mockResolvedValue({
      id: 'client_registered',
      name: 'Registered Client',
      redirectUris: ['http://localhost:8080/callback'],
      grants: ['authorization_code', 'refresh_token'],
      scopes: ['mcp'],
      _id: 'oauth_app_1',
    })
  })

  describe('GET /oauth/authorize (showAuthorizePage)', () => {
    it('returns 400 invalid_request if client_id is missing', async () => {
      const req = { query: {} }
      const res = createMockRes()

      await OAuth2AuthorizeController.showAuthorizePage(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.include({
        error: 'invalid_request',
        error_description: 'client_id is required',
      })
    })

    it('returns 400 invalid_client if client_id is unknown', async () => {
      vi.spyOn(OauthApplication, 'findOne').mockResolvedValue(null)

      const req = {
        query: {
          client_id: 'unknown_client',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.showAuthorizePage(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.include({
        error: 'invalid_client',
      })
    })

    it('returns 400 invalid_request if redirect_uri is missing', async () => {
      const req = {
        query: {
          client_id: 'client_registered',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.showAuthorizePage(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.include({
        error: 'invalid_request',
        error_description: 'redirect_uri is required',
      })
    })

    it('returns 400 invalid_request if redirect_uri is not allowed for client', async () => {
      const req = {
        query: {
          client_id: 'client_registered',
          redirect_uri: 'https://evil.com/callback',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.showAuthorizePage(req, res)
      expect(res.statusCode).to.equal(400)
      expect(res.responseData).to.deep.include({
        error: 'invalid_request',
        error_description: 'redirect_uri is not allowed for this client',
      })
    })

    it('redirects to redirect_uri with error if response_type is not code', async () => {
      const req = {
        query: {
          client_id: 'client_registered',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'token',
          state: 'xyz123',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.showAuthorizePage(req, res)
      expect(res.redirectUrl).to.include('http://localhost:8080/callback')
      expect(res.redirectUrl).to.include('error=unsupported_response_type')
      expect(res.redirectUrl).to.include('state=xyz123')
    })

    it('redirects to redirect_uri with error if PKCE code_challenge is missing', async () => {
      const req = {
        query: {
          client_id: 'client_registered',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          state: 'xyz123',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.showAuthorizePage(req, res)
      expect(res.redirectUrl).to.include('http://localhost:8080/callback')
      expect(res.redirectUrl).to.include('error=invalid_request')
      expect(res.redirectUrl).to.include('code_challenge+is+required')
    })

    it('redirects to redirect_uri with error if code_challenge_method is not S256 (strict PKCE)', async () => {
      const req = {
        query: {
          client_id: 'client_registered',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          code_challenge: 'plain_challenge',
          code_challenge_method: 'plain',
          state: 'xyz123',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.showAuthorizePage(req, res)
      expect(res.redirectUrl).to.include('http://localhost:8080/callback')
      expect(res.redirectUrl).to.include('error=invalid_request')
      expect(res.redirectUrl).to.include('S256')
    })

    it('redirects to /login if user is not logged in', async () => {
      vi.spyOn(SessionManager, 'getSessionUser').mockReturnValue(null)

      const req = {
        query: {
          client_id: 'client_registered',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          code_challenge: 'E9Melhoa2OwvFrGMTJguCH5rtx64LxPU67A5CdFbW74',
          code_challenge_method: 'S256',
          state: 'xyz123',
        },
        originalUrl: '/oauth/authorize?client_id=claude&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&response_type=code&code_challenge=E9Melhoa2OwvFrGMTJguCH5rtx64LxPU67A5CdFbW74&code_challenge_method=S256&state=xyz123',
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.showAuthorizePage(req, res)
      expect(res.redirectUrl.startsWith('/login?redir=')).to.be.true
      expect(res.redirectUrl).to.include('client_id%3Dclaude')
    })

    it('renders oauth/authorize consent page when request is valid and user is logged in', async () => {
      vi.spyOn(SessionManager, 'getSessionUser').mockReturnValue(dummyUser)

      const req = {
        query: {
          client_id: 'client_registered',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          code_challenge: 'E9Melhoa2OwvFrGMTJguCH5rtx64LxPU67A5CdFbW74',
          code_challenge_method: 'S256',
          state: 'xyz123',
          scope: 'mcp',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.showAuthorizePage(req, res)
      expect(res.renderedView).to.equal('oauth/authorize')
      expect(res.renderedData).to.exist
      expect(res.renderedData.client.id).to.equal('client_registered')
      expect(res.renderedData.user.email).to.equal('test@example.com')
      expect(res.renderedData.scope).to.equal('mcp')
      expect(res.renderedData.state).to.equal('xyz123')
      expect(res.renderedData.code_challenge).to.equal('E9Melhoa2OwvFrGMTJguCH5rtx64LxPU67A5CdFbW74')
      expect(res.renderedData.code_challenge_method).to.equal('S256')
    })

    it('supports dynamic registered clients from database', async () => {
      vi.spyOn(SessionManager, 'getSessionUser').mockReturnValue(dummyUser)
      vi.spyOn(OauthApplication, 'findOne').mockResolvedValue({
        id: 'client_custom123',
        name: 'My Custom MCP App',
        redirectUris: ['http://localhost:5000/callback'],
        scopes: ['mcp'],
        grants: ['authorization_code'],
      })

      const req = {
        query: {
          client_id: 'client_custom123',
          redirect_uri: 'http://localhost:5000/callback',
          response_type: 'code',
          code_challenge: 'E9Melhoa2OwvFrGMTJguCH5rtx64LxPU67A5CdFbW74',
          code_challenge_method: 'S256',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.showAuthorizePage(req, res)
      expect(res.renderedView).to.equal('oauth/authorize')
      expect(res.renderedData.client.name).to.equal('My Custom MCP App')
    })
  })

  describe('POST /oauth/authorize (handleAuthorize)', () => {
    it('redirects with access_denied when user clicks Cancel/Deny', async () => {
      const req = {
        body: {
          action: 'deny',
          client_id: 'client_registered',
          redirect_uri: 'http://localhost:8080/callback',
          state: 'state_deny_123',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.handleAuthorize(req, res)
      expect(res.redirectUrl).to.include('http://localhost:8080/callback')
      expect(res.redirectUrl).to.include('error=access_denied')
      expect(res.redirectUrl).to.include('state=state_deny_123')
    })

    it('redirects to /login if user session is missing on submission', async () => {
      vi.spyOn(SessionManager, 'getSessionUser').mockReturnValue(null)

      const req = {
        body: {
          action: 'authorize',
          client_id: 'client_registered',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          code_challenge: 'E9Melhoa2OwvFrGMTJguCH5rtx64LxPU67A5CdFbW74',
          code_challenge_method: 'S256',
          state: 'state123',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.handleAuthorize(req, res)
      expect(res.redirectUrl.startsWith('/login?redir=')).to.be.true
    })

    it('issues an authorization code (oac_ prefix, 5m TTL) and redirects with code, state, and iss', async () => {
      vi.spyOn(SessionManager, 'getSessionUser').mockReturnValue(dummyUser)
      let createdDoc = null
      vi.spyOn(OauthAuthorizationCode, 'create').mockImplementation(async doc => {
        createdDoc = doc
        return doc
      })

      const req = {
        body: {
          action: 'authorize',
          client_id: 'client_registered',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          code_challenge: 'E9Melhoa2OwvFrGMTJguCH5rtx64LxPU67A5CdFbW74',
          code_challenge_method: 'S256',
          state: 'state_success_456',
          scope: 'mcp',
        },
      }
      const res = createMockRes()

      await OAuth2AuthorizeController.handleAuthorize(req, res)

      expect(createdDoc).to.exist
      expect(createdDoc.authorizationCode).to.match(/^oac_[a-f0-9]{32}$/)
      expect(createdDoc.redirectUri).to.equal('http://localhost:8080/callback')
      expect(createdDoc.scope).to.equal('mcp')
      expect(createdDoc.user_id).to.equal(dummyUser._id)
      expect(createdDoc.codeChallenge).to.equal('E9Melhoa2OwvFrGMTJguCH5rtx64LxPU67A5CdFbW74')
      expect(createdDoc.codeChallengeMethod).to.equal('S256')

      // 5 min TTL check
      const now = Date.now()
      const expiry = new Date(createdDoc.expiresAt).getTime()
      expect(expiry - now).to.be.closeTo(5 * 60 * 1000, 5000)

      expect(res.redirectUrl).to.include('http://localhost:8080/callback')
      expect(res.redirectUrl).to.include(`code=${createdDoc.authorizationCode}`)
      expect(res.redirectUrl).to.include('state=state_success_456')
      expect(res.redirectUrl).to.include('iss=http%3A%2F%2Flocalhost%3A3000')
    })
  })
})
