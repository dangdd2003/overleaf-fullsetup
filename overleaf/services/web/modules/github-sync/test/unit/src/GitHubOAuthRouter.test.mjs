import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = {
  users: new Map(),
  audit: [],
  lastUserUpdate: null,
  projectStates: new Map(),
  unlinkedUsers: [],
  unlinkedProjects: [],
  importedProjects: [],
  createdRepos: [],
  markedModified: [],
  removedUsers: [],
  inactiveProjects: [],
  canReadProject: true,
  canWriteProject: true,
  syncBusy: false,
}

const settingsMock = () => ({
  default: {
    siteUrl: 'https://overleaf.test',
    enableGithubSync: true,
    githubSync: {
      apiBase: 'https://api.github.test',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    },
  },
  __esModule: true,
})

const loggerMock = () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    err: vi.fn(),
  },
  __esModule: true,
})

const passportOAuth2Mock = () => ({
  default: class MockOAuth2Strategy {
    constructor(options, verify) {
      this.options = options
      this.verify = verify
    }
  },
  Strategy: class MockOAuth2Strategy {
    constructor(options, verify) {
      this.options = options
      this.verify = verify
    }
  },
  __esModule: true,
})

const passportMock = () => ({
  default: {
    use: vi.fn(),
    authenticate: vi.fn((strategy, options, callback) => {
      return (req, res, next) => {
        if (typeof options === 'function') {
          return options(req, res, next)
        }
        if (typeof callback === 'function') {
          if (req.mockAuthError) {
            return callback(req.mockAuthError, null)
          }
          return callback(null, true)
        }
        if (next) return next()
      }
    }),
  },
  __esModule: true,
})

const credsMock = () => ({
  default: {
    promises: {
      storeCredentials: async (userId, payload) => {
        db.users.set(String(userId), payload)
      },
      getCredentials: async userId => db.users.get(String(userId)) || null,
      getAccessToken: async userId => {
        const cred = db.users.get(String(userId))
        if (!cred) throw new Error('not linked')
        return cred.accessToken
      },
      deleteCredentials: async userId => db.users.delete(String(userId)),
    },
  },
  __esModule: true,
})

const apiMock = () => ({
  default: {
    promises: {
      getUser: async token => ({ id: 42, login: 'octocat' }),
      getPrimaryEmail: async () => 'octo@example.com',
      listRepos: async token => [{ id: 1, name: 'repo-1' }],
      listOrgs: async token => [{ id: 1, login: 'org-1' }],
    },
  },
  __esModule: true,
})

const userMock = () => ({
  User: {
    updateOne: async (query, update) => {
      db.lastUserUpdate = { query, update }
      return { modifiedCount: 1 }
    },
  },
  __esModule: true,
})

const auditMock = () => ({
  default: {
    promises: {
      addEntry: async (...args) => {
        db.audit.push(args)
      },
    },
  },
  __esModule: true,
})

const authControllerMock = () => ({
  default: {
    requireLogin: () => (req, res, next) => next(),
  },
  __esModule: true,
})

const authManagerMock = () => ({
  default: {
    promises: {
      canUserReadProject: async (userId, projectId) => db.canReadProject,
      canUserWriteProjectContent: async (userId, projectId) =>
        db.canWriteProject,
    },
  },
  __esModule: true,
})

const syncManagerMock = () => ({
  default: {
    promises: {
      getState: async projectId => db.projectStates.get(String(projectId)) || null,
      getStatus: async projectId => ({ status: 'synced', projectId }),
      pull: async projectId => {
        if (db.syncBusy) {
          const err = new Error('Project is currently busy syncing')
          err.code = 'busy'
          throw err
        }
        return { status: 'pulled', projectId }
      },
      push: async (projectId, message) => {
        if (db.syncBusy) {
          const err = new Error('Project is currently busy syncing')
          err.code = 'busy'
          throw err
        }
        return { status: 'pushed', projectId, message }
      },
      unlinkProject: async projectId => {
        db.unlinkedProjects.push(String(projectId))
        db.projectStates.delete(String(projectId))
      },
      unlinkAllForUser: async userId => {
        db.unlinkedUsers.push(String(userId))
      },
      importProject: async (userId, opts) => {
        db.importedProjects.push({ userId, opts })
        return { projectId: 'imported-proj-1' }
      },
      continueAfterManualMerge: async projectId => ({ status: 'continued', projectId }),
      createRepoAndLink: async (userId, projectId, opts) => {
        db.createdRepos.push({ userId, projectId, opts })
        return { repoUrl: `https://github.com/${opts.owner}/${opts.name}` }
      },
      markProjectModified: async projectId => {
        db.markedModified.push(String(projectId))
      },
      onUserRemoved: async userId => {
        db.removedUsers.push(String(userId))
      },
      onProjectInactive: async projectId => {
        db.inactiveProjects.push(String(projectId))
      },
    },
  },
  __esModule: true,
})

function mockAll(customSettings = settingsMock) {
  vi.doMock('passport', passportMock)
  vi.doMock('passport-oauth2', passportOAuth2Mock)
  vi.doMock('@overleaf/logger', loggerMock)
  vi.doMock('@overleaf/settings', customSettings)
  vi.doMock('../../../app/src/GitHubCredentialsManager.mjs', credsMock)
  vi.doMock('../../../app/src/GitHubApiManager.mjs', apiMock)
  vi.doMock('../../../app/src/GitHubSyncManager.mjs', syncManagerMock)
  vi.doMock('../../../../../app/src/models/User.mjs', userMock)
  vi.doMock('../../../../../app/src/Features/User/UserAuditLogHandler.mjs', auditMock)
  vi.doMock('../../../../../app/src/Features/Authentication/AuthenticationController.mjs', authControllerMock)
  vi.doMock('../../../../../app/src/Features/Authorization/AuthorizationManager.mjs', authManagerMock)
}

mockAll()

describe('GitHub OAuth verify callback', function () {
  let handleOAuthVerify

  beforeEach(async function () {
    vi.resetModules()
    db.users.clear()
    db.audit = []
    db.lastUserUpdate = null
    mockAll()
    const mod = await import('../../../app/src/GitHubPassportStrategy.mjs')
    handleOAuthVerify = mod.handleOAuthVerify
  })

  it('stores credentials, sets features.github, records tpi and audit log', async function () {
    const req = { user: { _id: 'user1' }, ip: '1.2.3.4', session: {} }
    const result = await handleOAuthVerify(req, 'access-token-123', null, {
      id: 42,
      login: 'octocat',
    })
    expect(result).to.equal(true)
    expect(db.users.get('user1')).to.deep.include({
      githubUserId: 42,
      githubUsername: 'octocat',
      email: 'octo@example.com',
      accessToken: 'access-token-123',
    })
    expect(db.lastUserUpdate.update.$set['features.github']).to.equal(true)
    expect(db.lastUserUpdate.update.$push.thirdPartyIdentifiers).to.deep.equal({
      providerId: 'github',
      externalUserId: '42',
    })
    expect(db.audit[0][1]).to.equal('link-github')
    expect(req.session.projectSyncSuccessMessage).to.equal('GitHub account linked')
  })
})

describe('GitHubPassportStrategy createStrategy', function () {
  it('registers strategy with passport when enabled and credentials present', async function () {
    vi.resetModules()
    mockAll()
    const { createStrategy } = await import('../../../app/src/GitHubPassportStrategy.mjs')
    const mockPassport = { use: vi.fn() }
    createStrategy(mockPassport)
    expect(mockPassport.use).toHaveBeenCalledOnce()
    const strategy = mockPassport.use.mock.calls[0][0]
    expect(strategy.name).to.equal('github-sync')
  })

  it('no-ops when enableGithubSync is false', async function () {
    vi.resetModules()
    mockAll(() => ({
      default: {
        enableGithubSync: false,
        githubSync: { clientId: 'id', clientSecret: 'sec' },
      },
      __esModule: true,
    }))
    const { createStrategy } = await import('../../../app/src/GitHubPassportStrategy.mjs')
    const mockPassport = { use: vi.fn() }
    createStrategy(mockPassport)
    expect(mockPassport.use).not.toHaveBeenCalled()
  })

  it('no-ops when clientId or clientSecret is missing', async function () {
    vi.resetModules()
    mockAll(() => ({
      default: {
        enableGithubSync: true,
        githubSync: { clientId: '', clientSecret: '' },
      },
      __esModule: true,
    }))
    const { createStrategy } = await import('../../../app/src/GitHubPassportStrategy.mjs')
    const mockPassport = { use: vi.fn() }
    createStrategy(mockPassport)
    expect(mockPassport.use).not.toHaveBeenCalled()
  })
})

describe('GitHubOAuthRouter routes', function () {
  let router

  beforeEach(async function () {
    vi.resetModules()
    db.users.clear()
    db.audit = []
    db.lastUserUpdate = null
    db.unlinkedUsers = []
    db.importedProjects = []
    mockAll()
    const mod = await import('../../../app/src/GitHubOAuthRouter.mjs')
    router = mod.default
  })

  it('applies routes to webRouter and nonCsrfRouter', function () {
    const routes = []
    const webRouter = {
      get: (path, ...handlers) => routes.push({ method: 'GET', path, handlers }),
      post: (path, ...handlers) => routes.push({ method: 'POST', path, handlers }),
    }
    router.apply(webRouter)
    router.applyNonCsrfRouter(webRouter)

    const paths = routes.map(r => `${r.method} ${r.path}`)
    expect(paths).to.include('GET /auth/github/oauth')
    expect(paths).to.include('GET /auth/github/status')
    expect(paths).to.include('GET /auth/github/repos')
    expect(paths).to.include('GET /auth/github/orgs')
    expect(paths).to.include('POST /auth/github/unlink')
    expect(paths).to.include('POST /auth/github/import')
    expect(paths).to.include('GET /auth/github/callback')
    expect(paths).to.include('GET /user/github/link')
    expect(paths).to.include('GET /user/github/status')
    expect(paths).to.include('GET /user/github/callback')
  })

  it('status returns { linked: false, username: null } when unlinked', async function () {
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-unlinked' } }
    let jsonResult
    const res = { json: data => { jsonResult = data } }

    await routes['/auth/github/status'](req, res)
    expect(jsonResult).to.deep.equal({ linked: false, username: null })
  })

  it('status returns { linked: true, username } when linked', async function () {
    db.users.set('user-linked', { githubUsername: 'octocat', accessToken: 'tok' })
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-linked' } }
    let jsonResult
    const res = { json: data => { jsonResult = data } }

    await routes['/auth/github/status'](req, res)
    expect(jsonResult).to.deep.equal({ linked: true, username: 'octocat' })
  })

  it('repos returns repo list', async function () {
    db.users.set('user-1', { accessToken: 'tok' })
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-1' } }
    let jsonResult
    const res = { json: data => { jsonResult = data } }

    await routes['/auth/github/repos'](req, res)
    expect(jsonResult).to.deep.equal({ repos: [{ id: 1, name: 'repo-1' }] })
  })

  it('orgs returns org list', async function () {
    db.users.set('user-1', { accessToken: 'tok' })
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-1' } }
    let jsonResult
    const res = { json: data => { jsonResult = data } }

    await routes['/user/github/orgs'](req, res)
    expect(jsonResult).to.deep.equal({ orgs: [{ id: 1, login: 'org-1' }] })
  })

  it('unlink unlinks all projects, updates user, adds audit entry', async function () {
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-1' }, ip: '1.2.3.4' }
    let jsonResult
    const res = { json: data => { jsonResult = data } }

    await routes['/user/github/unlink'](req, res)
    expect(jsonResult).to.deep.equal({ ok: true })
    expect(db.unlinkedUsers).to.include('user-1')
    expect(db.lastUserUpdate.update.$set['features.github']).to.equal(false)
    expect(db.lastUserUpdate.update.$pull.thirdPartyIdentifiers).to.deep.equal({
      providerId: 'github',
    })
    expect(db.audit[0][1]).to.equal('unlink-github')
  })

  it('importProject validates repoOwner/repoName and imports', async function () {
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = {
      user: { _id: 'user-1' },
      body: { repoOwner: 'octo', repoName: 'test', branch: 'main', projectName: 'My Proj' },
    }
    let jsonResult
    const res = { json: data => { jsonResult = data }, status: () => res }

    await routes['/user/github/import'](req, res)
    expect(jsonResult).to.deep.equal({ projectId: 'imported-proj-1' })
    expect(db.importedProjects[0].opts).to.deep.equal({
      repoOwner: 'octo',
      repoName: 'test',
      branch: 'main',
      projectName: 'My Proj',
    })
  })

  it('importProject returns 400 when parameters missing', async function () {
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-1' }, body: {} }
    let statusSet, jsonResult
    const res = {
      status: s => {
        statusSet = s
        return { json: data => { jsonResult = data } }
      },
    }

    await routes['/user/github/import'](req, res)
    expect(statusSet).to.equal(400)
    expect(jsonResult.code).to.equal('invalidParameters')
  })

  it('callback handles auth failure by setting error flag in session', async function () {
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
    }
    router.applyNonCsrfRouter(webRouter)

    const req = { mockAuthError: new Error('oauth failed'), session: {} }
    let redirectedTo
    const res = { redirect: url => { redirectedTo = url } }

    routes['/user/github/callback'](req, res, () => {})
    expect(req.session.githubSyncError).to.equal(true)
    expect(redirectedTo).to.equal('/user/settings')
  })
})

describe('GitHubSyncRouter routes', function () {
  let router

  beforeEach(async function () {
    vi.resetModules()
    db.projectStates.clear()
    db.unlinkedProjects = []
    db.createdRepos = []
    db.canReadProject = true
    db.syncBusy = false
    mockAll()
    const mod = await import('../../../app/src/GitHubSyncRouter.mjs')
    router = mod.default
  })

  it('status returns project sync status if user can read project', async function () {
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-1' }, params: { projectId: 'proj-1' } }
    let jsonResult
    const res = { json: data => { jsonResult = data } }

    await routes['/project/:projectId/github/status'](req, res)
    expect(jsonResult).to.deep.equal({ status: 'synced', projectId: 'proj-1' })
  })

  it('status returns 403 when user cannot read project', async function () {
    db.canReadProject = false
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-1' }, params: { projectId: 'proj-1' } }
    let statusSet, jsonResult
    const res = {
      status: s => {
        statusSet = s
        return { json: data => { jsonResult = data } }
      },
    }

    await routes['/project/:projectId/github/status'](req, res)
    expect(statusSet).to.equal(403)
    expect(jsonResult.code).to.equal('forbidden')
  })

  it('pull returns 404 notLinked when project is not linked', async function () {
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-1' }, params: { projectId: 'proj-1' } }
    let statusSet, jsonResult
    const res = {
      status: s => {
        statusSet = s
        return { json: data => { jsonResult = data } }
      },
    }

    await routes['/project/:projectId/github/pull'](req, res)
    expect(statusSet).to.equal(404)
    expect(jsonResult.code).to.equal('notLinked')
  })

  it('pull returns 403 when user is not the linked owner', async function () {
    db.projectStates.set('proj-1', { user_id: 'other-user' })
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-1' }, params: { projectId: 'proj-1' } }
    let statusSet, jsonResult
    const res = {
      status: s => {
        statusSet = s
        return { json: data => { jsonResult = data } }
      },
    }

    await routes['/project/:projectId/github/pull'](req, res)
    expect(statusSet).to.equal(403)
    expect(jsonResult.code).to.equal('only_project_owner_can_link_github')
  })

  it('pull returns 409 when sync is busy', async function () {
    db.projectStates.set('proj-1', { user_id: 'user-1' })
    db.syncBusy = true
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-1' }, params: { projectId: 'proj-1' } }
    let statusSet, jsonResult
    const res = {
      status: s => {
        statusSet = s
        return { json: data => { jsonResult = data } }
      },
    }

    await routes['/project/:projectId/github/pull'](req, res)
    expect(statusSet).to.equal(409)
    expect(jsonResult.code).to.equal('busy')
  })

  it('push performs push operation for linked owner', async function () {
    db.projectStates.set('proj-1', { user_id: 'user-1' })
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = {
      user: { _id: 'user-1' },
      params: { projectId: 'proj-1' },
      body: { message: 'commit msg' },
    }
    let jsonResult
    const res = { json: data => { jsonResult = data } }

    await routes['/project/:projectId/github/push'](req, res)
    expect(jsonResult).to.deep.equal({
      status: 'pushed',
      projectId: 'proj-1',
      message: 'commit msg',
    })
  })

  it('unlink removes link for linked owner', async function () {
    db.projectStates.set('proj-1', { user_id: 'user-1' })
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const req = { user: { _id: 'user-1' }, params: { projectId: 'proj-1' } }
    let jsonResult
    const res = { json: data => { jsonResult = data } }

    await routes['/project/:projectId/github/unlink'](req, res)
    expect(jsonResult).to.deep.equal({ ok: true })
    expect(db.unlinkedProjects).to.include('proj-1')
  })

  it('createRepo validates name and checks alreadyLinked', async function () {
    const routes = {}
    const webRouter = {
      get: (path, auth, handler) => { routes[path] = handler },
      post: (path, auth, handler) => { routes[path] = handler },
    }
    router.apply(webRouter)

    const reqMissingName = {
      user: { _id: 'user-1' },
      params: { projectId: 'proj-1' },
      body: {},
    }
    let statusSet, jsonResult
    const res = {
      status: s => {
        statusSet = s
        return { json: data => { jsonResult = data } }
      },
      json: data => { jsonResult = data },
    }

    await routes['/project/:projectId/github/create-repo'](reqMissingName, res)
    expect(statusSet).to.equal(400)
    expect(jsonResult.code).to.equal('invalidParameters')

    db.projectStates.set('proj-1', { user_id: 'user-1' })
    const reqAlreadyLinked = {
      user: { _id: 'user-1' },
      params: { projectId: 'proj-1' },
      body: { name: 'new-repo' },
    }
    await routes['/project/:projectId/github/create-repo'](reqAlreadyLinked, res)
    expect(statusSet).to.equal(409)
    expect(jsonResult.code).to.equal('alreadyLinked')
  })
})

describe('index.mjs hooks and router wiring', function () {
  beforeEach(function () {
    vi.resetModules()
    db.markedModified = []
    db.removedUsers = []
    db.inactiveProjects = []
    mockAll()
  })

  it('wires hooks.promises and passportSetup correctly', async function () {
    const { default: module } = await import('../../../index.mjs')
    const mockPassport = { use: vi.fn() }
    let setupCalled = false
    await module.hooks.passportSetup(mockPassport, err => {
      expect(err).toBeUndefined()
      setupCalled = true
    })
    expect(setupCalled).to.equal(true)

    await module.hooks.promises.projectModified({ projectId: 'p1' })
    expect(db.markedModified).to.include('p1')

    await module.hooks.promises.removeGithub('u1')
    await module.hooks.promises.deleteUser('u2')
    await module.hooks.promises.expireDeletedUser('u3')
    expect(db.removedUsers).to.deep.equal(['u1', 'u2', 'u3'])

    await module.hooks.promises.deactivateProject('p2')
    await module.hooks.promises.projectExpired('p3')
    expect(db.inactiveProjects).to.deep.equal(['p2', 'p3'])
  })
})
