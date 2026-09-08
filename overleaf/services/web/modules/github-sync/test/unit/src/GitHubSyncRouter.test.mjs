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
  return res
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
    const record = method => (path, ...handlers) => {
      routes[`${method} ${path}`] = handlers[handlers.length - 1]
    }
    GitHubSyncRouter.apply({ get: record('get'), post: record('post') })
  }

  function handler(key) {
    const fn = routes[key]
    if (!fn) {
      throw new Error(`route not registered: ${key}. Have: ${Object.keys(routes).join(', ')}`)
    }
    return fn
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
