import http from 'node:http'
import { Readable } from 'node:stream'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  createBearerAuthMiddleware,
  createHttpApp,
  expandHosts,
  originHostnames,
  requireBearerToken,
  proxyToInternalUrl,
} from '../../../src/http.js'
import { OverleafApiError } from '../../../src/errors.js'

function mockRes() {
  const res = {}
  res.status = sinon.stub().returns(res)
  res.json = sinon.stub().returns(res)
  res.setHeader = sinon.stub().returns(res)
  return res
}

describe('requireBearerToken', function () {
  it('accepts a bearer header and attaches the token to req.auth', async function () {
    const client = { get: sinon.stub().resolves([]) }
    const req = { get: () => 'Bearer olp_0123456789abcdef' }
    const res = mockRes()
    const next = sinon.stub()
    await createBearerAuthMiddleware(client)(req, res, next)
    expect(next.calledOnce).to.be.true
    expect(req.auth.token).to.equal('olp_0123456789abcdef')
    expect(req.auth.scopes).to.deep.equal(['mcp'])
  })

  it('is case-insensitive on the scheme', async function () {
    const client = { get: sinon.stub().resolves([]) }
    const req = { get: () => 'bearer olp_0123456789abcdef' }
    const next = sinon.stub()
    await createBearerAuthMiddleware(client)(req, mockRes(), next)
    expect(next.calledOnce).to.be.true
  })

  it('rejects an opaque token when there is no client to validate it', async function () {
    const req = { get: () => 'Bearer olp_0123456789abcdef' }
    const res = mockRes()
    const next = sinon.stub()
    await requireBearerToken(req, res, next)
    expect(next.called).to.be.false
    expect(res.status.calledWith(401)).to.be.true
    expect(res.json.firstCall.args[0].code).to.equal('unauthorized')
  })

  it('rejects a missing header with the unauthorized envelope', async function () {
    const req = { get: () => undefined }
    const res = mockRes()
    const next = sinon.stub()
    await requireBearerToken(req, res, next)
    expect(next.called).to.be.false
    expect(res.status.calledWith(401)).to.be.true
    expect(res.json.firstCall.args[0].code).to.equal('unauthorized')
    expect(res.setHeader.calledWith('WWW-Authenticate')).to.be.true
    expect(res.setHeader.firstCall.args[1]).to.include('resource_metadata=')
  })

  it('rejects a non-bearer scheme', async function () {
    const req = { get: () => 'Basic dXNlcjpwYXNz' }
    const res = mockRes()
    const next = sinon.stub()
    await requireBearerToken(req, res, next)
    expect(next.called).to.be.false
    expect(res.status.calledWith(401)).to.be.true
  })

  it('ignores a token supplied in the query string or body', async function () {
    const req = {
      get: () => undefined,
      query: { token: 'olp_0123456789abcdef' },
      body: { token: 'olp_0123456789abcdef' },
    }
    const res = mockRes()
    const next = sinon.stub()
    await requireBearerToken(req, res, next)
    expect(next.called).to.be.false
    expect(res.status.calledWith(401)).to.be.true
  })

  describe('client validation via createBearerAuthMiddleware', function () {
    it('validates token with web backend and caches it', async function () {
      const client = { get: sinon.stub().resolves({ projects: [] }) }
      const middleware = createBearerAuthMiddleware(client)
      const req = { get: () => 'Bearer olp_validtoken' }
      const res = mockRes()
      const next = sinon.stub()

      await middleware(req, res, next)
      expect(client.get.calledOnceWith('olp_validtoken', '/projects')).to.be.true
      // Validation needs one row, not a full project listing.
      expect(client.get.firstCall.args[2]).to.deep.equal({ limit: 1 })
      expect(next.calledOnce).to.be.true

      // Second request with same token should hit cache and NOT call client.get again
      const next2 = sinon.stub()
      await middleware(req, mockRes(), next2)
      expect(client.get.calledOnce).to.be.true
      expect(next2.calledOnce).to.be.true
    })

    it('does not echo the text of an unexpected validation failure to the caller', async function () {
      const client = { get: sinon.stub().rejects(new Error('ECONNRESET at web.internal:3000')) }
      const middleware = createBearerAuthMiddleware(client)
      const req = { get: () => 'Bearer olp_unexpected' }
      const res = mockRes()
      await middleware(req, res, sinon.stub())
      expect(res.status.calledWith(401)).to.be.true
      expect(res.json.firstCall.args[0].message).to.equal('valid authentication required')
    })

    it('rejects an invalid token with 401', async function () {
      const client = {
        get: sinon.stub().rejects(new OverleafApiError('unauthorized', 'invalid token', 401)),
      }
      const middleware = createBearerAuthMiddleware(client)
      const req = { get: () => 'Bearer olp_badtoken' }
      const res = mockRes()
      const next = sinon.stub()

      await middleware(req, res, next)
      expect(next.called).to.be.false
      expect(res.status.calledWith(401)).to.be.true
      expect(res.json.firstCall.args[0].code).to.equal('unauthorized')
    })

    it('rejects a token without mcp scope with 403', async function () {
      const client = {
        get: sinon.stub().rejects(new OverleafApiError('insufficient_scope', 'missing mcp scope', 403)),
      }
      const middleware = createBearerAuthMiddleware(client)
      const req = { get: () => 'Bearer olp_gitonly' }
      const res = mockRes()
      const next = sinon.stub()

      await middleware(req, res, next)
      expect(next.called).to.be.false
      expect(res.status.calledWith(403)).to.be.true
      expect(res.json.firstCall.args[0].code).to.equal('insufficient_scope')
    })

    it('works when requireBearerToken is used directly as a factory with client', async function () {
      const client = { get: sinon.stub().resolves({ projects: [] }) }
      const middleware = requireBearerToken(client)
      const req = { get: () => 'Bearer olp_factory_token' }
      const res = mockRes()
      const next = sinon.stub()

      await middleware(req, res, next)
      expect(client.get.calledOnceWith('olp_factory_token', '/projects')).to.be.true
      expect(next.calledOnce).to.be.true
    })

    it('validates using req.app.locals.client if requireBearerToken is mounted as bare middleware', async function () {
      const client = { get: sinon.stub().resolves({ projects: [] }) }
      const req = {
        get: () => 'Bearer olp_app_locals_token',
        app: { locals: { client } },
      }
      const res = mockRes()
      const next = sinon.stub()

      await requireBearerToken(req, res, next)
      expect(client.get.calledOnceWith('olp_app_locals_token', '/projects')).to.be.true
      expect(next.calledOnce).to.be.true

      // Second request with same token should hit cache and NOT call client.get again
      const next2 = sinon.stub()
      await requireBearerToken(req, mockRes(), next2)
      expect(client.get.calledOnce).to.be.true
      expect(next2.calledOnce).to.be.true
    })

    it('verifies valid JWT token statelessly via jwtVerifier without calling client.get', async function () {
      const client = { get: sinon.stub().resolves({ projects: [] }) }
      const jwtVerifier = {
        verifyToken: sinon.stub().resolves({
          sub: 'jwt_user_123',
          client_id: 'claude',
          scope: 'mcp',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      }
      const middleware = createBearerAuthMiddleware(client, { jwtVerifier })
      const req = { get: () => 'Bearer aaaaa.bbbbb.ccccc' }
      const res = mockRes()
      const next = sinon.stub()

      await middleware(req, res, next)
      expect(jwtVerifier.verifyToken.calledOnceWith('aaaaa.bbbbb.ccccc')).to.be.true
      expect(client.get.called).to.be.false
      expect(next.calledOnce).to.be.true
      expect(req.auth.userId).to.equal('jwt_user_123')
      expect(req.auth.clientId).to.equal('claude')
      expect(req.auth.scopes).to.deep.equal(['mcp'])

      // Second request hits cache
      const next2 = sinon.stub()
      await middleware(req, mockRes(), next2)
      expect(jwtVerifier.verifyToken.calledOnce).to.be.true
      expect(next2.calledOnce).to.be.true
    })

    it('answers 503 when the signing keys cannot be fetched, instead of rejecting the token', async function () {
      const client = {
        get: sinon.stub(),
        fetchImpl: async () => {
          throw new TypeError('fetch failed')
        },
      }
      const config = {
        resourceUri: 'https://overleaf.example.com/mcp',
        authServerUrl: 'https://overleaf.example.com',
      }
      const middleware = createBearerAuthMiddleware(client, { config })
      // A well-formed RS256 header is needed so verification reaches the key fetch.
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url')
      const body = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')
      const req = { get: () => `Bearer ${header}.${body}.c2ln` }
      const res = mockRes()
      const next = sinon.stub()

      await middleware(req, res, next)
      expect(next.called).to.be.false
      expect(res.status.calledWith(503)).to.be.true
      expect(res.json.firstCall.args[0].code).to.equal('temporarily_unavailable')
      expect(res.setHeader.calledWith('Retry-After', '30')).to.be.true
    })

    it('rejects invalid JWT with 401 and challenge header', async function () {
      const client = { get: sinon.stub().resolves({ projects: [] }) }
      const jwtVerifier = {
        verifyToken: sinon.stub().rejects(new Error('JWT has expired')),
      }
      const middleware = createBearerAuthMiddleware(client, { jwtVerifier })
      const req = { get: () => 'Bearer aaaaa.bbbbb.ccccc' }
      const res = mockRes()
      const next = sinon.stub()

      await middleware(req, res, next)
      expect(next.called).to.be.false
      expect(res.status.calledWith(401)).to.be.true
      expect(res.json.firstCall.args[0].code).to.equal('invalid_token')
      expect(res.setHeader.calledWith('WWW-Authenticate')).to.be.true
      expect(res.setHeader.firstCall.args[1]).to.include('error="invalid_token"')
    })
  })

  describe('JWT without the mcp scope', function () {
    it('answers 403 insufficient_scope with a matching challenge and attaches no auth', async function () {
      const scopeError = new Error('JWT missing required "mcp" scope')
      scopeError.code = 'insufficient_scope'
      const jwtVerifier = { verifyToken: sinon.stub().rejects(scopeError) }
      const middleware = createBearerAuthMiddleware(null, { jwtVerifier })
      const req = { get: () => 'Bearer aaaaa.bbbbb.ccccc' }
      const res = mockRes()
      const next = sinon.stub()

      await middleware(req, res, next)
      expect(next.called).to.be.false
      expect(res.status.calledWith(403)).to.be.true
      expect(res.json.firstCall.args[0].code).to.equal('insufficient_scope')
      expect(res.setHeader.firstCall.args[0]).to.equal('WWW-Authenticate')
      expect(res.setHeader.firstCall.args[1]).to.include('error="insufficient_scope"')
    })
  })

  describe('originHostnames', function () {
    it('reduces configured origin URLs to the hostnames the SDK compares', function () {
      expect(originHostnames(['https://chat.example.com', 'gemini.example.com:8443'])).to.deep.equal([
        'chat.example.com',
        'gemini.example.com',
      ])
    })

    it('keeps a bracketed IPv6 host intact', function () {
      expect(originHostnames(['http://[::1]:3000'])).to.deep.equal(['[::1]'])
    })
  })

  describe('allowedOrigins in the running app', function () {
    // The SDK checks Origin by hostname, so a configured full URL must still admit
    // the browser origin it names, and nothing else.
    const config = {
      host: '127.0.0.1',
      port: 0,
      endpointPath: '/mcp',
      internalUrl: '',
      resourceUri: 'https://overleaf.example.com/mcp',
      authServerUrl: 'https://overleaf.example.com',
      allowedHosts: [],
      allowedOrigins: ['https://chat.example.com'],
    }
    let server
    let baseUrl

    before(async function () {
      const { app } = createHttpApp({ config, client: null })
      server = http.createServer(app)
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      baseUrl = `http://127.0.0.1:${server.address().port}`
    })

    after(async function () {
      if (server) await new Promise(resolve => server.close(resolve))
    })

    it('admits a listed origin given as a full URL', async function () {
      const res = await fetch(`${baseUrl}/tools/metadata`, {
        headers: { origin: 'https://chat.example.com' },
      })
      expect(res.status).to.equal(200)
    })

    it('refuses an origin that is not listed', async function () {
      const res = await fetch(`${baseUrl}/tools/metadata`, {
        headers: { origin: 'https://evil.example.com' },
      })
      expect(res.status).to.equal(403)
    })
  })

  describe('expandHosts', function () {
    it('normalises hostnames and preserves entries without redundant ports', function () {
      const input = [
        'localhost',
        '127.0.0.1',
        '10.3.64.252:3050',
        'overleaf-test-2.ddangw.me',
        'example.com:443',
        '[::1]:3050',
        '::1',
      ]
      const expanded = expandHosts(input)
      expect(expanded).to.include('localhost')
      expect(expanded).to.include('127.0.0.1')
      expect(expanded).to.include('10.3.64.252')
      expect(expanded).to.include('overleaf-test-2.ddangw.me')
      expect(expanded).to.include('example.com')
      expect(expanded).to.include('[::1]')
      // Redundant dead entries with ports should not be blindly appended for bare domains
      expect(expanded).to.not.include('overleaf-test-2.ddangw.me:80')
      expect(expanded).to.not.include('overleaf-test-2.ddangw.me:443')
      expect(expanded).to.not.include('overleaf-test-2.ddangw.me:3050')
    })
  })

  describe('proxyToInternalUrl', function () {
    let originalFetch

    beforeEach(function () {
      originalFetch = globalThis.fetch
    })

    afterEach(function () {
      globalThis.fetch = originalFetch
    })

    it('forwards GET request and sets status, headers, and body', async function () {
      globalThis.fetch = sinon.stub().resolves({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: async () => Buffer.from(JSON.stringify({ ok: true })),
      })

      const req = {
        method: 'GET',
        url: '/.well-known/oauth-authorization-server',
        headers: { accept: 'application/json' },
      }
      const res = {
        status: sinon.stub().returnsThis(),
        setHeader: sinon.stub().returnsThis(),
        send: sinon.stub(),
        json: sinon.stub(),
      }

      await proxyToInternalUrl(req, res, 'http://web:3000')

      expect(globalThis.fetch.calledOnce).to.be.true
      const [calledUrl, calledOpts] = globalThis.fetch.firstCall.args
      expect(calledUrl.href).to.equal('http://web:3000/.well-known/oauth-authorization-server')
      expect(calledOpts.method).to.equal('GET')
      expect(res.status.calledWith(200)).to.be.true
      expect(res.send.calledOnce).to.be.true
    })

    it('streams a form body that express left unparsed, such as a login post', async function () {
      globalThis.fetch = sinon.stub().resolves({
        status: 302,
        headers: new Headers({ location: 'http://web:3000/oauth/authorize' }),
        arrayBuffer: async () => Buffer.alloc(0),
      })
      const req = Readable.from([Buffer.from('email=a%40b.c&password=x')])
      req.method = 'POST'
      req.url = '/login'
      req.headers = { 'content-type': 'application/x-www-form-urlencoded' }
      req.body = {}
      const res = {
        status: sinon.stub().returnsThis(),
        setHeader: sinon.stub().returnsThis(),
        send: sinon.stub(),
        json: sinon.stub(),
      }

      await proxyToInternalUrl(req, res, 'http://web:3000')

      const [, calledOpts] = globalThis.fetch.firstCall.args
      expect(calledOpts.duplex).to.equal('half')
      expect(await new Response(calledOpts.body).text()).to.equal('email=a%40b.c&password=x')
    })

    it('does not forward hop-by-hop headers and sets a deadline on the upstream request', async function () {
      globalThis.fetch = sinon.stub().resolves({
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => Buffer.alloc(0),
      })
      const req = {
        method: 'GET',
        url: '/js/app.js',
        headers: {
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
          'keep-alive': 'timeout=5',
          'accept-language': 'en',
        },
      }
      const res = {
        status: sinon.stub().returnsThis(),
        setHeader: sinon.stub().returnsThis(),
        send: sinon.stub(),
        json: sinon.stub(),
      }

      await proxyToInternalUrl(req, res, 'http://web:3000')

      const [, calledOpts] = globalThis.fetch.firstCall.args
      expect(calledOpts.headers.has('connection')).to.be.false
      expect(calledOpts.headers.has('transfer-encoding')).to.be.false
      expect(calledOpts.headers.has('keep-alive')).to.be.false
      expect(calledOpts.headers.get('accept-language')).to.equal('en')
      expect(calledOpts.signal).to.be.instanceOf(AbortSignal)
    })

    it('forwards POST request with body to internal URL', async function () {
      globalThis.fetch = sinon.stub().resolves({
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: async () => Buffer.from(JSON.stringify({ client_id: '123' })),
      })

      const req = {
        method: 'POST',
        url: '/oauth/register',
        headers: { 'content-type': 'application/json' },
        body: { client_name: 'test' },
      }
      const res = {
        status: sinon.stub().returnsThis(),
        setHeader: sinon.stub().returnsThis(),
        send: sinon.stub(),
        json: sinon.stub(),
      }

      await proxyToInternalUrl(req, res, 'http://web:3000')

      expect(globalThis.fetch.calledOnce).to.be.true
      const [, calledOpts] = globalThis.fetch.firstCall.args
      expect(calledOpts.method).to.equal('POST')
      expect(calledOpts.body).to.equal(JSON.stringify({ client_name: 'test' }))
      expect(res.status.calledWith(201)).to.be.true
    })

    describe('redirect Location headers', function () {
      async function proxyRedirect(location) {
        globalThis.fetch = sinon.stub().resolves({
          status: 302,
          headers: new Headers({ location }),
          arrayBuffer: async () => Buffer.alloc(0),
        })
        const req = { method: 'GET', url: '/oauth/authorize', headers: {} }
        const res = {
          status: sinon.stub().returnsThis(),
          setHeader: sinon.stub().returnsThis(),
          send: sinon.stub(),
          json: sinon.stub(),
        }
        await proxyToInternalUrl(req, res, 'http://web:3000')
        return res
      }

      it('rewrites a Location on the internal origin into a path on this origin', async function () {
        const res = await proxyRedirect('http://web:3000/login?next=%2Foauth')
        expect(res.setHeader.calledWith('location', '/login?next=%2Foauth')).to.be.true
      })

      it('rewrites a protocol-relative Location on the internal origin', async function () {
        const res = await proxyRedirect('//web:3000/login')
        expect(res.setHeader.calledWith('location', '/login')).to.be.true
      })

      it('keeps a Location that points at another origin', async function () {
        const res = await proxyRedirect('https://accounts.example.com/sign-in')
        expect(res.setHeader.calledWith('location', 'https://accounts.example.com/sign-in')).to.be.true
      })

      it('drops a Location that cannot be parsed rather than forwarding it', async function () {
        const res = await proxyRedirect('http://[broken')
        const forwarded = res.setHeader.getCalls().some(call => call.args[0] === 'location')
        expect(forwarded).to.be.false
      })
    })

    it('returns 502 bad_gateway when upstream fetch rejects', async function () {
      globalThis.fetch = sinon.stub().rejects(new Error('Connection refused'))

      const req = {
        method: 'GET',
        url: '/oauth/token',
        headers: {},
      }
      const res = {
        status: sinon.stub().returnsThis(),
        json: sinon.stub(),
      }

      await proxyToInternalUrl(req, res, 'http://web:3000')

      expect(res.status.calledWith(502)).to.be.true
      expect(res.json.firstCall.args[0].error).to.equal('bad_gateway')
    })
  })
})

describe('protected resource metadata routes', function () {
  // ChatGPT and Gemini build the discovery URL straight from the MCP server URL
  // per RFC 9728 §3.1, so the path-insertion form must be served or their OAuth
  // client resolution fails before it ever reaches dynamic client registration.
  const config = {
    host: '127.0.0.1',
    port: 0,
    endpointPath: '/mcp',
    internalUrl: '',
    resourceUri: 'https://overleaf.example.com/mcp',
    authServerUrl: 'https://overleaf.example.com',
    allowedHosts: [],
    allowedOrigins: [],
  }

  let server
  let baseUrl

  before(async function () {
    const { app } = createHttpApp({ config, client: null })
    server = http.createServer(app)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve))
  })

  it('does not cap the request body at the SDK default size', async function () {
    // Auth runs after the body is parsed, so a parsed body reaches the 401
    // here; a body over the SDK's 100kb default would be refused with 413.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer olp_0123456789abcdef',
      },
      body: JSON.stringify({ data: 'A'.repeat(300 * 1024) }),
    })
    expect(res.status).to.equal(401)
  })

  it('serves metadata at the RFC 9728 path-insertion URL', async function () {
    const res = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`
    )
    expect(res.status).to.equal(200)
    expect(await res.json()).to.deep.include({
      resource: 'https://overleaf.example.com/mcp',
    })
  })

  it('still serves metadata at the bare well-known URL', async function () {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)
    expect(res.status).to.equal(200)
    expect((await res.json()).resource).to.equal(
      'https://overleaf.example.com/mcp'
    )
  })

  it('advertises the path-insertion URL in the 401 challenge', async function () {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' })
    expect(res.status).to.equal(401)
    expect(res.headers.get('www-authenticate')).to.include(
      'resource_metadata="https://overleaf.example.com/.well-known/oauth-protected-resource/mcp"'
    )
  })

  it('serves tool metadata without requiring a bearer token', async function () {
    const res = await fetch(`${baseUrl}/tools/metadata`)
    expect(res.status).to.equal(200)
    const body = await res.json()
    const byKey = Object.fromEntries(body.categories.map(c => [c.key, c]))
    expect(Object.keys(byKey)).to.have.members([
      'projects',
      'files',
      'compile',
      'latex',
      'history',
      'tags',
    ])
    const allTools = body.categories.flatMap(c => c.tools)
    expect(allTools).to.have.length(40)
    for (const tool of allTools) {
      expect(tool.name).to.be.a('string').and.not.be.empty
      expect(tool.description).to.be.a('string').and.not.be.empty
      expect(tool.params).to.be.an('array')
    }
  })
})
