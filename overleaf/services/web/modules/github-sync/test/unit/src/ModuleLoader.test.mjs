import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const INDEX = '../../../index.mjs'

function fakeWebRouter() {
  const registered = []
  const record = method => (path, ...handlers) =>
    registered.push({ method, path, handlers })
  return {
    registered,
    get: record('get'),
    post: record('post'),
    put: record('put'),
    delete: record('delete'),
  }
}

describe('github-sync module', function () {
  let mockSettings
  let oauthRouter
  let syncRouter
  let syncManager
  let createStrategy

  beforeEach(function () {
    mockSettings = {}
    oauthRouter = { apply: vi.fn(), applyNonCsrfRouter: vi.fn() }
    syncRouter = { apply: vi.fn() }
    syncManager = {
      promises: {
        markProjectModified: vi.fn().mockResolvedValue(undefined),
        onUserRemoved: vi.fn().mockResolvedValue(undefined),
        onProjectInactive: vi.fn().mockResolvedValue(undefined),
      },
    }
    createStrategy = vi.fn()

    vi.resetModules()
    vi.doMock('@overleaf/settings', () => ({
      default: mockSettings,
      __esModule: true,
    }))
    vi.doMock('../../../app/src/ModuleSettings.mjs', () => ({ default: {} }))
    vi.doMock('../../../app/src/GitHubOAuthRouter.mjs', () => ({ default: oauthRouter }))
    vi.doMock('../../../app/src/GitHubSyncRouter.mjs', () => ({ default: syncRouter }))
    vi.doMock('../../../app/src/GitHubSyncManager.mjs', () => ({ default: syncManager }))
    vi.doMock('../../../app/src/GitHubPassportStrategy.mjs', () => ({ createStrategy }))
  })

  afterEach(function () {
    vi.restoreAllMocks()
  })

  it('exports a WebModule with router and hooks', async function () {
    const { default: GithubSyncModule } = await import(INDEX)
    expect(GithubSyncModule.name).to.equal('github-sync')
    expect(typeof GithubSyncModule.router.apply).to.equal('function')
    expect(typeof GithubSyncModule.router.applyNonCsrfRouter).to.equal(
      'function'
    )
    expect(typeof GithubSyncModule.hooks.promises).to.equal('object')
  })

  describe('when enableGithubSync is false', function () {
    beforeEach(function () {
      mockSettings.enableGithubSync = false
    })

    it('registers no routes via apply', async function () {
      const { default: GithubSyncModule } = await import(INDEX)
      const webRouter = fakeWebRouter()

      await GithubSyncModule.router.apply(webRouter, {}, {})

      expect(webRouter.registered).to.have.length(0)
      expect(oauthRouter.apply).not.toHaveBeenCalled()
      expect(syncRouter.apply).not.toHaveBeenCalled()
    })

    it('registers no routes via applyNonCsrfRouter', async function () {
      const { default: GithubSyncModule } = await import(INDEX)
      const webRouter = fakeWebRouter()

      await GithubSyncModule.router.applyNonCsrfRouter(webRouter, {}, {})

      expect(webRouter.registered).to.have.length(0)
      expect(oauthRouter.applyNonCsrfRouter).not.toHaveBeenCalled()
    })

    it('still invokes the passportSetup callback so boot does not hang', async function () {
      const { default: GithubSyncModule } = await import(INDEX)
      const callback = vi.fn()

      await GithubSyncModule.hooks.passportSetup({}, callback)

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0][0]).to.be.undefined
      expect(createStrategy).not.toHaveBeenCalled()
    })

    it('does not touch the sync manager on projectModified', async function () {
      const { default: GithubSyncModule } = await import(INDEX)

      await GithubSyncModule.hooks.promises.projectModified({
        projectId: 'project-1',
      })

      expect(syncManager.promises.markProjectModified).not.toHaveBeenCalled()
    })

    it('does not touch the sync manager on user and project lifecycle hooks', async function () {
      const { default: GithubSyncModule } = await import(INDEX)
      const { promises: hooks } = GithubSyncModule.hooks

      await hooks.removeGithub('user-1')
      await hooks.deleteUser('user-1')
      await hooks.expireDeletedUser('user-1')
      await hooks.deactivateProject('project-1')
      await hooks.projectExpired('project-1')

      expect(syncManager.promises.onUserRemoved).not.toHaveBeenCalled()
      expect(syncManager.promises.onProjectInactive).not.toHaveBeenCalled()
    })
  })

  describe('when enableGithubSync is true', function () {
    beforeEach(function () {
      mockSettings.enableGithubSync = true
    })

    it('applies both routers', async function () {
      const { default: GithubSyncModule } = await import(INDEX)
      const webRouter = fakeWebRouter()

      await GithubSyncModule.router.apply(webRouter, {}, {})

      expect(oauthRouter.apply).toHaveBeenCalledWith(webRouter)
      expect(syncRouter.apply).toHaveBeenCalledWith(webRouter)
    })

    it('applies the non-CSRF OAuth callback router', async function () {
      const { default: GithubSyncModule } = await import(INDEX)
      const webRouter = fakeWebRouter()

      await GithubSyncModule.router.applyNonCsrfRouter(webRouter, {}, {})

      expect(oauthRouter.applyNonCsrfRouter).toHaveBeenCalledWith(webRouter)
    })

    it('forwards projectModified to the sync manager', async function () {
      const { default: GithubSyncModule } = await import(INDEX)

      await GithubSyncModule.hooks.promises.projectModified({
        projectId: 'project-1',
      })

      expect(syncManager.promises.markProjectModified).toHaveBeenCalledWith(
        'project-1'
      )
    })

    it('forwards lifecycle hooks to the sync manager', async function () {
      const { default: GithubSyncModule } = await import(INDEX)
      const { promises: hooks } = GithubSyncModule.hooks

      await hooks.removeGithub('user-1')
      await hooks.deactivateProject('project-1')

      expect(syncManager.promises.onUserRemoved).toHaveBeenCalledWith('user-1')
      expect(syncManager.promises.onProjectInactive).toHaveBeenCalledWith(
        'project-1'
      )
    })
  })
})
