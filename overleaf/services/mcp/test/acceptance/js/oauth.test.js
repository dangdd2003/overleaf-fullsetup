import http from 'node:http'
import crypto from 'node:crypto'
import { expect } from 'chai'
import { createHttpApp } from '../../../src/http.js'
import { OverleafClient } from '../../../src/OverleafClient.js'
import { createJwtVerifier } from '../../../src/oauth.js'

function startServer(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}/mcp` })
    })
  })
}

async function rpc(url, body, { token } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  const line = text.split('\n').find(l => l.startsWith('data: '))
  return {
    status: response.status,
    headers: response.headers,
    body: line ? JSON.parse(line.slice(6)) : text,
  }
}

describe('OAuth 2.1 Complete Handshake Acceptance Test', function () {
  let mcpRunning
  let webServer
  let webPort
  let keyPair
  let mockJwks
  let authCodes
  let accessTokens

  before(function () {
    // Generate RSA key pair for authorization server signing RS256 JWTs
    keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = keyPair.publicKey.export({ format: 'jwk' })
    mockJwks = {
      keys: [{ ...jwk, kid: 'auth-key-1', alg: 'RS256', use: 'sig' }],
    }
  })

  beforeEach(async function () {
    authCodes = new Map()
    accessTokens = new Map()

    // 1. Start a mock Overleaf Web Authorization Server simulating /oauth/authorize, /oauth/token, JWKS, etc.
    const webApp = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${webPort || 3000}`)

      if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(mockJwks))
        return
      }

      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: `http://127.0.0.1:${webPort}`,
            authorization_endpoint: `http://127.0.0.1:${webPort}/oauth/authorize`,
            token_endpoint: `http://127.0.0.1:${webPort}/oauth/token`,
            jwks_uri: `http://127.0.0.1:${webPort}/.well-known/jwks.json`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['mcp'],
            token_endpoint_auth_methods_supported: ['none'],
          })
        )
        return
      }

      // Authorization Endpoint simulation
      if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
        const clientId = url.searchParams.get('client_id')
        const redirectUri = url.searchParams.get('redirect_uri')
        const codeChallenge = url.searchParams.get('code_challenge')
        const codeChallengeMethod = url.searchParams.get('code_challenge_method')
        const state = url.searchParams.get('state')
        const resource = url.searchParams.get('resource')
        const scope = url.searchParams.get('scope') || 'mcp'

        const code = `code_${crypto.randomBytes(16).toString('hex')}`
        authCodes.set(code, {
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
          resource,
          scope,
          userId: 'user_oauth_test_123',
          expiresAt: Date.now() + 60000,
        })

        const cb = new URL(redirectUri)
        cb.searchParams.set('code', code)
        if (state) cb.searchParams.set('state', state)

        res.writeHead(302, { Location: cb.toString() })
        res.end()
        return
      }

      // Token Endpoint simulation (PKCE verification & RS256 JWT minting)
      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        let bodyText = ''
        for await (const chunk of req) {
          bodyText += chunk
        }
        let params = {}
        if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
          params = Object.fromEntries(new URLSearchParams(bodyText))
        } else {
          try {
            params = JSON.parse(bodyText)
          } catch {
            params = {}
          }
        }

        const { grant_type, code, code_verifier, client_id, redirect_uri } = params

        if (grant_type !== 'authorization_code') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unsupported_grant_type' }))
          return
        }

        const authRecord = authCodes.get(code)
        if (!authRecord || authRecord.expiresAt < Date.now()) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Code invalid or expired' }))
          return
        }

        // Single-use code deletion
        authCodes.delete(code)

        // PKCE S256 verification
        const hash = crypto
          .createHash('sha256')
          .update(code_verifier || '')
          .digest('base64url')

        if (hash !== authRecord.codeChallenge) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }))
          return
        }

        // Mint RS256 JWT
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'auth-key-1' })).toString(
          'base64url'
        )
        const payload = Buffer.from(
          JSON.stringify({
            sub: authRecord.userId,
            iss: `http://127.0.0.1:${webPort}`,
            aud: authRecord.resource || mcpRunning.url,
            client_id: client_id || authRecord.clientId,
            scope: authRecord.scope,
            jti: `jwt_${crypto.randomBytes(16).toString('hex')}`,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          })
        ).toString('base64url')

        const input = `${header}.${payload}`
        const sig = crypto.createSign('SHA256').update(input).sign(keyPair.privateKey, 'base64url')
        const accessToken = `${input}.${sig}`
        const refreshToken = `oar_${crypto.randomBytes(32).toString('hex')}`

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: refreshToken,
            scope: authRecord.scope,
          })
        )
        return
      }

      // Mock projects endpoint called when tool is executed with bearer token
      if (req.method === 'GET' && url.pathname === '/api/v0/mcp/projects') {
        const auth = req.headers.authorization || ''
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            projects: [
              {
                id: 'proj_123',
                name: 'Thesis',
                lastUpdated: new Date().toISOString(),
                accessLevel: 'owner',
              },
            ],
          })
        )
        return
      }

      res.writeHead(404)
      res.end()
    })

    webServer = await new Promise(resolve => {
      const s = webApp.listen(0, '127.0.0.1', () => resolve(s))
    })
    webPort = webServer.address().port

    // 2. Start MCP server pointing to the mock auth/web server
    const client = new OverleafClient({
      baseUrl: `http://127.0.0.1:${webPort}`,
    })

    const config = {
      host: '127.0.0.1',
      port: 0,
      endpointPath: '/mcp',
      allowedHosts: [],
      allowedOrigins: [],
      resourceUri: 'http://127.0.0.1:0/mcp', // Will update after port bind
      authServerUrl: `http://127.0.0.1:${webPort}`,
    }

    const { app } = createHttpApp({ config, client })
    mcpRunning = await startServer(app)
    config.resourceUri = mcpRunning.url
  })

  afterEach(function (done) {
    let closed = 0
    const finish = () => {
      closed++
      if (closed === 2) done()
    }
    mcpRunning.server.close(finish)
    webServer.close(finish)
  })

  it('completes the full RFC 9728 & OAuth 2.1 handshake with PKCE and executes MCP tools', async function () {
    // STEP 1: Unauthenticated request to MCP endpoint receives 401 challenge with WWW-Authenticate pointing to /.well-known/oauth-protected-resource
    const initialReq = await rpc(mcpRunning.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })

    expect(initialReq.status).to.equal(401)
    const wwwAuth = initialReq.headers.get('www-authenticate')
    expect(wwwAuth).to.exist
    expect(wwwAuth).to.include('Bearer')
    expect(wwwAuth).to.include('resource_metadata=')
    expect(wwwAuth).to.include('/.well-known/oauth-protected-resource')

    // Parse resource metadata URL from WWW-Authenticate header
    const metaMatch = /resource_metadata="([^"]+)"/.exec(wwwAuth)
    expect(metaMatch).to.exist
    const resourceMetadataUrl = metaMatch[1]

    // STEP 2: Client queries RFC 9728 Protected Resource Metadata to discover authorization server
    const resMetaResp = await fetch(resourceMetadataUrl)
    expect(resMetaResp.status).to.equal(200)
    const resourceMetadata = await resMetaResp.json()
    expect(resourceMetadata.resource).to.equal(mcpRunning.url)
    expect(resourceMetadata.authorization_servers).to.deep.equal([`http://127.0.0.1:${webPort}`])
    expect(resourceMetadata.scopes_supported).to.include('mcp')

    const authServerUrl = resourceMetadata.authorization_servers[0]

    // STEP 3: Discovery of authorization server metadata (RFC 8414)
    const asMetaResp = await fetch(`${authServerUrl}/.well-known/oauth-authorization-server`)
    expect(asMetaResp.status).to.equal(200)
    const asMetadata = await asMetaResp.json()
    expect(asMetadata.authorization_endpoint).to.equal(`${authServerUrl}/oauth/authorize`)
    expect(asMetadata.token_endpoint).to.equal(`${authServerUrl}/oauth/token`)
    expect(asMetadata.code_challenge_methods_supported).to.include('S256')

    // STEP 4: PKCE code generation (RFC 7636) & Authorize request
    const codeVerifier = crypto.randomBytes(32).toString('base64url')
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const clientRedirectUri = 'http://127.0.0.1:54321/oauth/callback'
    const state = 'test_state_xyz_123'

    const authUrl = new URL(asMetadata.authorization_endpoint)
    authUrl.searchParams.set('client_id', 'claude-code')
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('redirect_uri', clientRedirectUri)
    authUrl.searchParams.set('scope', 'mcp')
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('resource', mcpRunning.url)

    // Simulate browser redirect / authorization grant
    const authResp = await fetch(authUrl.toString(), { redirect: 'manual' })
    expect(authResp.status).to.equal(302)
    const redirectLocation = new URL(authResp.headers.get('location'))
    expect(redirectLocation.origin + redirectLocation.pathname).to.equal(clientRedirectUri)
    expect(redirectLocation.searchParams.get('state')).to.equal(state)
    const authorizationCode = redirectLocation.searchParams.get('code')
    expect(authorizationCode).to.match(/^code_/)

    // STEP 5: Token exchange (PKCE verifier + Authorization Code) returning RS256 JWT
    const tokenResp = await fetch(asMetadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: authorizationCode,
        code_verifier: codeVerifier,
        client_id: 'claude-code',
        redirect_uri: clientRedirectUri,
      }),
    })

    expect(tokenResp.status).to.equal(200)
    const tokenData = await tokenResp.json()
    expect(tokenData.access_token).to.be.a('string')
    expect(tokenData.token_type).to.equal('Bearer')
    expect(tokenData.expires_in).to.equal(3600)
    expect(tokenData.refresh_token).to.match(/^oar_/)
    expect(tokenData.scope).to.equal('mcp')

    // Verify token structure is a 3-part RS256 JWT
    const jwtParts = tokenData.access_token.split('.')
    expect(jwtParts).to.have.length(3)

    // STEP 6: Authenticated MCP Initialize and Tool Execution with Bearer JWT
    const initResult = await rpc(
      mcpRunning.url,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'claude-code', version: '1.0.0' },
        },
      },
      { token: tokenData.access_token }
    )

    expect(initResult.status).to.equal(200)
    expect(initResult.body.result.serverInfo.name).to.equal('overleaf')

    // STEP 7: Authenticated tools/call with Bearer JWT
    const toolCallResult = await rpc(
      mcpRunning.url,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'list_projects',
          arguments: {},
        },
      },
      { token: tokenData.access_token }
    )

    expect(toolCallResult.status).to.equal(200)
    expect(toolCallResult.body.result).to.exist
    const content = JSON.parse(toolCallResult.body.result.content[0].text)
    expect(content.projects).to.be.an('array')
    expect(content.projects[0].name).to.equal('Thesis')
  })
})
