import { expect } from 'chai'
import sinon from 'sinon'
import {
  createBearerAuthMiddleware,
  expandHosts,
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
    const req = { get: () => 'Bearer olp_0123456789abcdef' }
    const res = mockRes()
    const next = sinon.stub()
    await requireBearerToken(req, res, next)
    expect(next.calledOnce).to.be.true
    expect(req.auth.token).to.equal('olp_0123456789abcdef')
    expect(req.auth.scopes).to.deep.equal(['mcp'])
  })

  it('is case-insensitive on the scheme', async function () {
    const req = { get: () => 'bearer olp_0123456789abcdef' }
    const next = sinon.stub()
    await requireBearerToken(req, mockRes(), next)
    expect(next.calledOnce).to.be.true
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
      expect(next.calledOnce).to.be.true

      // Second request with same token should hit cache and NOT call client.get again
      const next2 = sinon.stub()
      await middleware(req, mockRes(), next2)
      expect(client.get.calledOnce).to.be.true
      expect(next2.calledOnce).to.be.true
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
