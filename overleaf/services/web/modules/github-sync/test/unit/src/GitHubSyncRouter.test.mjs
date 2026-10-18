import { describe, it, expect, vi, beforeEach } from 'vitest'

const OWNER_ID = 'user-owner'
const PROJECT_ID = 'project-1'

function fakeRes() {
  const res = { statusCode: 200, body: null }
  res.status = code => {
    res.statusCode = code
    return res
  }
  res.json = payload => {
    res.body = payload
    return res
  }
  res.write = () => res
  res.end = () => res
  return res
}

// Stands in for the Redis-backed limiter; a rejected consume is a 429.
const rateLimitState = { reject: false, created: [] }

async function runChain(handlers, req, res) {
  for (const handler of handlers.slice(0, -1)) {
    let advanced = false
    await new Promise(resolve => {
      handler(req, res, () => {
        advanced = true
        resolve()
      })
      setTimeout(resolve, 10)
    })
    if (!advanced) return
  }
  return handlers[handlers.length - 1](req, res)
}

function fakeReq(overrides = {}) {
  return {
    user: { _id: OWNER_ID },
    params: { projectId: PROJECT_ID },
    body: {},
    ...overrides,
  }
}

describe('GitHubSyncRouter', function () {
  let routes
  let chains
  let authorizationManager
  let syncManager

  async function loadRouter() {
    vi.resetModules()

    const authControllerMock = () => ({
      default: {
        requireLogin: () => (req, res, next) => next(),
      },
      __esModule: true,
    })
    const authManagerMock = () => ({
      default: authorizationManager,
      __esModule: true,
    })
    const syncManagerMock = () => ({ default: syncManager, __esModule: true })
    const rateLimiterMock = () => ({
      RateLimiter: class {
        constructor(name, opts) {
          this.name = name
          this.opts = opts
          rateLimitState.created.push(this)
        }
        async consume() {
          if (rateLimitState.reject) throw { msBeforeNext: 1000 }
        }
      },
      __esModule: true,
    })
    vi.doMock(
      '../../../../../app/src/infrastructure/RateLimiter.mjs',
      rateLimiterMock
    )

    vi.doMock(
      '../../../../../app/src/Features/Authentication/AuthenticationController.mjs',
      authControllerMock
    )
    vi.doMock(
      '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs',
      authManagerMock
    )
    vi.doMock('../../../app/src/GitHubSyncManager.mjs', syncManagerMock)

    const { default: GitHubSyncRouter } = await import(
      '../../../app/src/GitHubSyncRouter.mjs'
    )

    routes = {}
    chains = {}
    const record = method => (path, ...handlers) => {
      routes[`${method} ${path}`] = handlers[handlers.length - 1]
      chains[`${method} ${path}`] = handlers
    }
    rateLimitState.created = []
    GitHubSyncRouter.apply({ get: record('get'), post: record('post') })
  }

  function handler(key) {
    const fn = routes[key]
    if (!fn) {
      throw new Error(`route not registered: ${key}. Have: ${Object.keys(routes).join(', ')}`)
    }
    return fn
  }

  it('creates its rate limiters when applied, with the documented limits', async function () {
    await loadRouter()
    const names = rateLimitState.created.map(l => l.name).sort()
    expect(names).to.deep.equal(['github-sync-create-repo', 'github-sync-sync'])
  })

  for (const route of [
    'post /project/:projectId/github/pull',
    'post /project/:projectId/github/push',
    'post /project/:projectId/github/create-repo',
  ]) {
    it(`${route} answers 429 and does no work when the user is over the limit`, async function () {
      await loadRouter()
      rateLimitState.reject = true
      try {
        const res = fakeRes()
        await runChain(chains[route], fakeReq({ body: { name: 'repo' } }), res)
        expect(res.statusCode).to.equal(429)
        expect(syncManager.promises.getState).not.toHaveBeenCalled()
        expect(syncManager.promises.pull).not.toHaveBeenCalled()
        expect(syncManager.promises.push).not.toHaveBeenCalled()
        expect(syncManager.promises.createRepoAndLink).not.toHaveBeenCalled()
      } finally {
        rateLimitState.reject = false
      }
    })
  }

  beforeEach(function () {
    authorizationManager = {
      promises: {
        canUserReadProject: vi.fn().mockResolvedValue(true),
        canUserWriteProjectContent: vi.fn().mockResolvedValue(true),
      },
    }
    syncManager = {
      promises: {
        getState: vi.fn().mockResolvedValue({ user_id: OWNER_ID }),
        getStatus: vi.fn().mockResolvedValue({ linked: true }),
        pull: vi.fn().mockResolvedValue({ ok: true }),
        push: vi.fn().mockResolvedValue({ ok: true }),
        unlinkProject: vi.fn().mockResolvedValue(undefined),
        continueAfterManualMerge: vi.fn().mockResolvedValue({ ok: true }),
        createRepoAndLink: vi.fn().mockResolvedValue({ ok: true }),
      },
    }
  })

  const MUTATING = [
    ['post /project/:projectId/github/pull', 'pull'],
    ['post /project/:projectId/github/push', 'push'],
    ['post /project/:projectId/github/unlink', 'unlinkProject'],
    ['post /project/:projectId/github/continue-merge', 'continueAfterManualMerge'],
  ]

  describe('write authorization on mutating routes', function () {
    for (const [route, managerMethod] of MUTATING) {
      it(`${route} rejects a linked owner who has lost write access`, async function () {
        authorizationManager.promises.canUserWriteProjectContent.mockResolvedValue(
          false
        )
        await loadRouter()

        const res = fakeRes()
        await handler(route)(fakeReq(), res)

        expect(res.statusCode).to.equal(403)
        expect(syncManager.promises[managerMethod]).not.toHaveBeenCalled()
      })

      it(`${route} proceeds when the linked owner still has write access`, async function () {
        await loadRouter()

        const res = fakeRes()
        await handler(route)(fakeReq(), res)

        expect(res.statusCode).to.equal(200)
        expect(syncManager.promises[managerMethod]).toHaveBeenCalled()
      })
    }

    it('create-repo rejects a user without write access', async function () {
      authorizationManager.promises.canUserWriteProjectContent.mockResolvedValue(false)
      syncManager.promises.getState.mockResolvedValue(null)
      await loadRouter()

      const res = fakeRes()
      await handler('post /project/:projectId/github/create-repo')(
        fakeReq({ body: { name: 'my-repo' } }),
        res
      )

      expect(res.statusCode).to.equal(403)
      expect(syncManager.promises.createRepoAndLink).not.toHaveBeenCalled()
    })

    it('create-repo proceeds for a user with write access', async function () {
      syncManager.promises.getState.mockResolvedValue(null)
      await loadRouter()

      const res = fakeRes()
      await handler('post /project/:projectId/github/create-repo')(
        fakeReq({ body: { name: 'my-repo' } }),
        res
      )

      expect(res.statusCode).to.equal(200)
      expect(syncManager.promises.createRepoAndLink).toHaveBeenCalled()
    })
  })

  describe('existing guards still apply', function () {
    it('rejects a user who is not the linked owner', async function () {
      syncManager.promises.getState.mockResolvedValue({ user_id: 'someone-else' })
      await loadRouter()

      const res = fakeRes()
      await handler('post /project/:projectId/github/pull')(fakeReq(), res)

      expect(res.statusCode).to.equal(403)
      expect(res.body.code).to.equal('only_project_owner_can_link_github')
    })

    it('returns 404 when the project is not linked', async function () {
      syncManager.promises.getState.mockResolvedValue(null)
      await loadRouter()

      const res = fakeRes()
      await handler('post /project/:projectId/github/pull')(fakeReq(), res)

      expect(res.statusCode).to.equal(404)
      expect(res.body.code).to.equal('notLinked')
    })

    it('status only requires read access', async function () {
      authorizationManager.promises.canUserWriteProjectContent.mockResolvedValue(false)
      await loadRouter()

      const res = fakeRes()
      await handler('get /project/:projectId/github/status')(fakeReq(), res)

      expect(res.statusCode).to.equal(200)
      expect(syncManager.promises.getStatus).toHaveBeenCalled()
    })

    it('status rejects a user without read access', async function () {
      authorizationManager.promises.canUserReadProject.mockResolvedValue(false)
      await loadRouter()

      const res = fakeRes()
      await handler('get /project/:projectId/github/status')(fakeReq(), res)

      expect(res.statusCode).to.equal(403)
    })
  })
})
