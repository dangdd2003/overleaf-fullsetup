// ============================================================================
// RELEASE GATE — MCP per-user auth model
// ----------------------------------------------------------------------------
// The `MCP API — cross-user isolation (RELEASE GATE)` describe block below is
// the acceptance gate for the MCP HTTP API's per-user authorization model.
// It MUST pass before `MCP_ENABLED=true` (Settings.enableMcp) is set
// on ANY multi-user instance. A regression here means one user's token can
// reach another user's projects — treat a failure as ship-blocking, not flaky.
//
// The suite exercises the full `/api/v0/mcp/*` surface with real
// `Authorization: Bearer <personal-access-token>` auth:
//   - authoring cycle: create project -> write doc -> read back -> compile
//   - isolation: user B's `mcp` token gets 404 on user A's private project
//     for read / tree / doc-write / compile (404 masks "no access")
//   - a `git_bridge`-only token is refused on the MCP API with 403
//     `insufficient_scope`
//   - a read-only collaborator can read (200) but not write (403 `forbidden`)
//   - no token at all -> 401 `unauthorized`
//
// Feature flag: the MCP routes are registered at app boot from
// `Settings.enableMcp`, so it cannot be toggled from a `before` hook. It is
// forced on for acceptance via `test/acceptance/config/settings.test.defaults.js`
// (`enableMcp: true`), which also activates `POST /user/personal-access-tokens`.
// ============================================================================

import { expect } from 'chai'
import Settings from '@overleaf/settings'
import UserHelper from './helpers/User.mjs'

const User = UserHelper.promises

// After `user.login()` the helper sets an `x-csrf-token` default header and a
// logged-in session cookie on `user.request`, so these browser-shaped requests
// pass CSRF. MCP auth itself only ever reads the `Authorization` header.
function bearer(user, method, path, token, json = true) {
  return user.doRequest(method, {
    url: path,
    json,
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function mintToken(user, name, scopes) {
  const { response, body } = await user.doRequest('POST', {
    url: '/user/personal-access-tokens',
    json: { name, scopes },
  })
  expect(response.statusCode, JSON.stringify(body)).to.equal(200)
  expect(body.token).to.be.a('string')
  return body.token
}

describe('MCP API — authoring cycle', function () {
  let user, token, projectId

  before(async function () {
    user = new User()
    await user.login()
    token = await mintToken(user, 'mcp-authoring', ['mcp'])
  })

  it('creates a project, writes a doc, reads it back and compiles', async function () {
    // create
    let r = await bearer(user, 'POST', '/api/v0/mcp/projects', token, {
      name: 'Acceptance Thesis',
    })
    expect(r.response.statusCode, JSON.stringify(r.body)).to.equal(200)
    expect(r.body.project).to.have.property('id')
    projectId = r.body.project.id

    // it shows up in the token owner's project list
    r = await bearer(user, 'GET', '/api/v0/mcp/projects', token)
    expect(r.response.statusCode).to.equal(200)
    expect(r.body.projects.map(p => p.id)).to.include(projectId)

    // write a new doc
    const content =
      '\\documentclass{article}\n\\begin{document}\nmcp-acceptance-marker\n\\end{document}'
    r = await bearer(
      user,
      'POST',
      `/api/v0/mcp/projects/${projectId}/doc`,
      token,
      { path: 'chapter1.tex', content }
    )
    expect(r.response.statusCode, JSON.stringify(r.body)).to.equal(200)
    expect(r.body.status).to.equal('ok')

    // read it back
    r = await bearer(
      user,
      'GET',
      `/api/v0/mcp/projects/${projectId}/doc?path=chapter1.tex`,
      token
    )
    expect(r.response.statusCode).to.equal(200)
    expect(r.body.content).to.contain('mcp-acceptance-marker')

    // read the project tree
    r = await bearer(
      user,
      'GET',
      `/api/v0/mcp/projects/${projectId}/tree`,
      token
    )
    expect(r.response.statusCode).to.equal(200)
    expect(r.body.docs.map(d => d.path)).to.include('/chapter1.tex')

    // compile
    r = await bearer(
      user,
      'POST',
      `/api/v0/mcp/projects/${projectId}/compile`,
      token,
      {}
    )
    expect(r.response.statusCode, JSON.stringify(r.body)).to.equal(200)
    expect(r.body).to.have.property('status')
    // On the acceptance stack (mock CLSI) a queued compile resolves to one of
    // these terminal states.
    expect(['success', 'failure']).to.include(r.body.status)
  })
})

describe('MCP API — cross-user isolation (RELEASE GATE)', function () {
  let userA, userB
  let tokenB, gitTokenB
  let aProjectId

  beforeEach(async function () {
    userA = new User()
    userB = new User()
    await userA.login()
    await userB.login()

    const tokenA = await mintToken(userA, 'mcp-a', ['mcp'])
    const p = await bearer(userA, 'POST', '/api/v0/mcp/projects', tokenA, {
      name: 'A private project',
    })
    expect(p.response.statusCode, JSON.stringify(p.body)).to.equal(200)
    aProjectId = p.body.project.id

    tokenB = await mintToken(userB, 'mcp-b', ['mcp'])
    gitTokenB = await mintToken(userB, 'git-b', ['git_bridge'])
  })

  it("B's mcp token cannot read A's project (404)", async function () {
    const r = await bearer(
      userB,
      'GET',
      `/api/v0/mcp/projects/${aProjectId}`,
      tokenB
    )
    expect(r.response.statusCode).to.equal(404)
    expect(r.body.code).to.equal('not_found')
  })

  it("B's mcp token cannot read A's project tree (404)", async function () {
    const r = await bearer(
      userB,
      'GET',
      `/api/v0/mcp/projects/${aProjectId}/tree`,
      tokenB
    )
    expect(r.response.statusCode).to.equal(404)
    expect(r.body.code).to.equal('not_found')
  })

  it("B's mcp token cannot write a doc in A's project (404)", async function () {
    const r = await bearer(
      userB,
      'POST',
      `/api/v0/mcp/projects/${aProjectId}/doc`,
      tokenB,
      { path: 'evil.tex', content: 'pwned' }
    )
    expect(r.response.statusCode).to.equal(404)
    expect(r.body.code).to.equal('not_found')
  })

  it("B's mcp token cannot compile A's project (404)", async function () {
    const r = await bearer(
      userB,
      'POST',
      `/api/v0/mcp/projects/${aProjectId}/compile`,
      tokenB,
      {}
    )
    expect(r.response.statusCode).to.equal(404)
    expect(r.body.code).to.equal('not_found')
  })

  it("B's git_bridge-only token is refused on the MCP API (403 insufficient_scope)", async function () {
    const r = await bearer(userB, 'GET', '/api/v0/mcp/projects', gitTokenB)
    expect(r.response.statusCode).to.equal(403)
    expect(r.body.code).to.equal('insufficient_scope')
  })

  it('no token at all is rejected (401 unauthorized)', async function () {
    const r = await userB.doRequest('GET', {
      url: '/api/v0/mcp/projects',
      json: true,
    })
    expect(r.response.statusCode).to.equal(401)
    expect(r.body.code).to.equal('unauthorized')
  })

  it('as a read-only collaborator, B can read the tree (200) but not write a doc (403 forbidden)', async function () {
    await userA.addUserToProject(aProjectId, userB, 'readOnly')

    let r = await bearer(
      userB,
      'GET',
      `/api/v0/mcp/projects/${aProjectId}/tree`,
      tokenB
    )
    expect(r.response.statusCode, JSON.stringify(r.body)).to.equal(200)
    expect(r.body).to.have.property('docs')

    r = await bearer(
      userB,
      'POST',
      `/api/v0/mcp/projects/${aProjectId}/doc`,
      tokenB,
      { path: 'evil.tex', content: 'pwned' }
    )
    expect(r.response.statusCode).to.equal(403)
    expect(r.body.code).to.equal('forbidden')
  })

  // Cross-feature bleed check: B's `mcp` token must NOT be accepted by the
  // git-bridge API, and B's `git_bridge` token must NOT be accepted by the MCP
  // API. Both features are enabled in the acceptance env
  // (Settings.enableGitBridge / enableMcp); skipped otherwise.
  //
  // NOTE: the acceptance suite should also grow cookieless-request coverage for
  // the MCP write routes (POST/PATCH with only an Authorization header and no
  // cookie jar) now that they are served from `publicApiRouter` — see
  // User.mjs's raw `doRequest` helper.
  it("B's mcp token is rejected by the git-bridge API (403 insufficient_scope)", async function () {
    if (!Settings.enableGitBridge) {
      this.skip()
    }
    const r = await bearer(userB, 'GET', `/api/v0/docs/${aProjectId}`, tokenB)
    expect(r.response.statusCode).to.equal(403)
    expect(r.body.code).to.equal('insufficient_scope')
  })

  it("B's git_bridge token is rejected by the MCP API (403 insufficient_scope)", async function () {
    const r = await bearer(userB, 'GET', '/api/v0/mcp/projects', gitTokenB)
    expect(r.response.statusCode).to.equal(403)
    expect(r.body.code).to.equal('insufficient_scope')
  })
})
