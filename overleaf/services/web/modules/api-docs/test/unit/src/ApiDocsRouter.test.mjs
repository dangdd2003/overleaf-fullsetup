import { describe, it, expect, vi, afterEach } from 'vitest'
import Settings from '@overleaf/settings'

describe('ApiDocsRouter', function () {
  let routes

  async function loadRouter() {
    vi.resetModules()
    vi.doMock(
      '../../../../../app/src/Features/Authentication/AuthenticationController.mjs',
      () => ({
        default: { requireLogin: () => (req, res, next) => next() },
        __esModule: true,
      })
    )
    const { default: ApiDocsRouter } =
      await import('../../../app/src/ApiDocsRouter.mjs')
    routes = {}
    const record =
      method =>
      (path, ...handlers) => {
        routes[`${method} ${path}`] = handlers[handlers.length - 1]
      }
    ApiDocsRouter.apply({ get: record('get') })
  }

  afterEach(function () {
    delete Settings.enableApiDocs
    delete Settings.enableGitBridge
    delete Settings.enableMcp
  })

  async function fetchSpec() {
    await loadRouter()
    const res = {
      json(payload) {
        this.body = payload
        return this
      },
    }
    await routes['get /api/v0/openapi.json']({}, res)
    return res.body
  }

  it('registers no routes when the feature is disabled', async function () {
    Settings.enableApiDocs = false
    await loadRouter()
    expect(Object.keys(routes)).to.deep.equal([])
  })

  it('registers /api-docs and /api/v0/openapi.json when enabled', async function () {
    Settings.enableApiDocs = true
    await loadRouter()
    expect(Object.keys(routes)).to.include('get /api-docs')
    expect(Object.keys(routes)).to.include('get /api/v0/openapi.json')
  })

  it('/api/v0/openapi.json responds with the spec as JSON', async function () {
    Settings.enableApiDocs = true
    Settings.enableGitBridge = true
    await loadRouter()
    const res = {
      json(payload) {
        this.body = payload
        return this
      },
    }
    await routes['get /api/v0/openapi.json']({}, res)
    expect(res.body.openapi).to.equal('3.0.3')
    expect(res.body.paths['/oauth/token/info']).to.exist
  })

  it('includes Git Bridge endpoints when git-bridge is enabled', async function () {
    Settings.enableApiDocs = true
    Settings.enableGitBridge = true
    await loadRouter()
    const res = {
      json(payload) {
        this.body = payload
        return this
      },
    }
    await routes['get /api/v0/openapi.json']({}, res)
    expect(res.body.paths['/oauth/token/info']).to.exist
    expect(res.body.paths['/api/v0/docs/{projectId}']).to.exist
    expect(res.body.paths['/user/personal-access-tokens']).to.exist
  })

  it('omits Git Bridge endpoints when git-bridge is disabled', async function () {
    Settings.enableApiDocs = true
    Settings.enableGitBridge = false
    await loadRouter()
    const res = {
      json(payload) {
        this.body = payload
        return this
      },
    }
    await routes['get /api/v0/openapi.json']({}, res)
    expect(res.body.paths['/oauth/token/info']).to.not.exist
    expect(res.body.paths['/api/v0/docs/{projectId}']).to.not.exist
    expect(res.body.paths['/api/v0/docs/{projectId}/saved_vers']).to.not.exist
    expect(res.body.paths['/api/v0/docs/{projectId}/snapshots/{versionId}']).to
      .not.exist
    expect(res.body.paths['/api/v0/docs/{projectId}/file/{fileId}']).to.not
      .exist
    expect(res.body.paths['/api/v0/docs/{projectId}/snapshots']).to.not.exist
  })

  it('omits MCP and OAuth2 endpoints when mcp is disabled', async function () {
    Settings.enableApiDocs = true
    Settings.enableGitBridge = true
    Settings.enableMcp = false
    const spec = await fetchSpec()
    expect(spec.paths['/api/v0/mcp/projects']).to.not.exist
    expect(spec.paths['/oauth/token']).to.not.exist
    expect(spec.paths['/.well-known/jwks.json']).to.not.exist
  })

  it('includes MCP and OAuth2 endpoints when mcp is enabled', async function () {
    Settings.enableApiDocs = true
    Settings.enableMcp = true
    const spec = await fetchSpec()
    expect(spec.paths['/api/v0/mcp/projects']).to.exist
    expect(spec.paths['/oauth/token']).to.exist
    expect(spec.paths['/.well-known/jwks.json']).to.exist
    expect(spec.paths['/api/v0/docs/{projectId}']).to.not.exist
  })

  it('shows personal access tokens when either git-bridge or mcp is enabled', async function () {
    Settings.enableApiDocs = true
    Settings.enableGitBridge = false
    Settings.enableMcp = true
    expect((await fetchSpec()).paths['/user/personal-access-tokens']).to.exist
    Settings.enableGitBridge = true
    Settings.enableMcp = false
    expect((await fetchSpec()).paths['/user/personal-access-tokens']).to.exist
  })

  it('omits personal access tokens when neither git-bridge nor mcp is enabled', async function () {
    Settings.enableApiDocs = true
    Settings.enableGitBridge = false
    Settings.enableMcp = false
    const spec = await fetchSpec()
    expect(spec.paths['/user/personal-access-tokens']).to.not.exist
  })
})
