import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest'

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

describe('google-drive-sync module', () => {
  let mockSettings
  let router
  let GoogleDrivePollingWorker
  let GoogleDriveOutboundWorker
  let GoogleDriveChannelRenewalWorker
  let GoogleDriveBulkSyncWorker
  let GoogleDriveImportWorker
  let GoogleDriveHookHandler
  let ensureJobIndexes
  let ensureProjectStateIndexes
  let addCleanupHandler

  beforeEach(() => {
    mockSettings = {
      enableGoogleDriveSync: false,
    }
    router = {
      apply: vi.fn(),
    }
    GoogleDrivePollingWorker = { start: vi.fn(), stop: vi.fn() }
    GoogleDriveOutboundWorker = { start: vi.fn(), stop: vi.fn() }
    GoogleDriveChannelRenewalWorker = { start: vi.fn(), stop: vi.fn() }
    GoogleDriveBulkSyncWorker = { start: vi.fn(), stop: vi.fn() }
    GoogleDriveImportWorker = { start: vi.fn(), stop: vi.fn() }
    GoogleDriveHookHandler = {
      onFileModified: vi.fn().mockResolvedValue(undefined),
      onEntityDeleted: vi.fn().mockResolvedValue(undefined),
      onDocModified: vi.fn().mockResolvedValue(undefined),
    }

    ensureJobIndexes = vi.fn().mockResolvedValue(undefined)
    ensureProjectStateIndexes = vi.fn().mockResolvedValue(undefined)
    addCleanupHandler = vi.fn()

    vi.resetModules()
    vi.doMock('@overleaf/settings', () => ({
      default: mockSettings,
      __esModule: true,
    }))
    vi.doMock('../../../app/src/ModuleSettings.mjs', () => ({ default: {} }))
    vi.doMock('../../../app/src/GoogleDriveRouter.mjs', () => ({
      default: router,
    }))
    vi.doMock('../../../app/src/GoogleDrivePollingWorker.mjs', () => ({
      default: GoogleDrivePollingWorker,
    }))
    vi.doMock('../../../app/src/GoogleDriveOutboundWorker.mjs', () => ({
      default: GoogleDriveOutboundWorker,
    }))
    vi.doMock('../../../app/src/GoogleDriveChannelRenewalWorker.mjs', () => ({
      default: GoogleDriveChannelRenewalWorker,
    }))
    vi.doMock('../../../app/src/GoogleDriveBulkSyncWorker.mjs', () => ({
      default: GoogleDriveBulkSyncWorker,
    }))
    vi.doMock('../../../app/src/GoogleDriveImportWorker.mjs', () => ({
      default: GoogleDriveImportWorker,
    }))
    vi.doMock('../../../app/src/GoogleDriveHookHandler.mjs', () => ({
      default: GoogleDriveHookHandler,
    }))
    vi.doMock('../../../app/src/models/GoogleDriveSyncModels.mjs', () => ({
      ensureJobIndexes,
      ensureProjectStateIndexes,
    }))
    vi.doMock(
      '../../../../../app/src/infrastructure/GracefulShutdown.mjs',
      () => ({
        addOptionalCleanupHandlerBeforeStoppingTraffic: addCleanupHandler,
      })
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports a WebModule with router, start and hooks', async () => {
    mockSettings.enableGoogleDriveSync = true
    const { default: module } = await import(INDEX)
    expect(module.name).to.equal('google-drive-sync')
    expect(typeof module.router.apply).to.equal('function')
    expect(typeof module.start).to.equal('function')
    expect(typeof module.hooks.promises).to.equal('object')
  })

  describe('when enableGoogleDriveSync is false', () => {
    beforeEach(() => {
      mockSettings.enableGoogleDriveSync = false
    })

    it('registers no routes via apply', async () => {
      const { default: module } = await import(INDEX)
      const webRouter = fakeWebRouter()

      await module.router.apply(webRouter, {}, {})

      expect(router.apply).not.toHaveBeenCalled()
    })

    it('starts no background workers via start()', async () => {
      const { default: module } = await import(INDEX)

      await module.start()

      expect(GoogleDrivePollingWorker.start).not.toHaveBeenCalled()
      expect(GoogleDriveOutboundWorker.start).not.toHaveBeenCalled()
      expect(GoogleDriveChannelRenewalWorker.start).not.toHaveBeenCalled()
      expect(GoogleDriveBulkSyncWorker.start).not.toHaveBeenCalled()
      expect(GoogleDriveImportWorker.start).not.toHaveBeenCalled()
    })

    it('registers no entity mutation hooks at all', async () => {
      const { default: module } = await import(INDEX)

      expect(module.hooks).toEqual({})
    })

    it('creates no job indexes and registers no shutdown cleanup', async () => {
      const { default: module } = await import(INDEX)

      await module.start()

      expect(ensureJobIndexes).not.toHaveBeenCalled()
      expect(ensureProjectStateIndexes).not.toHaveBeenCalled()
      expect(addCleanupHandler).not.toHaveBeenCalled()
    })
  })

  describe('when enableGoogleDriveSync is true', () => {
    beforeEach(() => {
      mockSettings.enableGoogleDriveSync = true
    })

    it('applies the router', async () => {
      const { default: module } = await import(INDEX)
      const webRouter = fakeWebRouter()
      const privateApiRouter = {}
      const publicApiRouter = {}

      await module.router.apply(webRouter, privateApiRouter, publicApiRouter)

      expect(router.apply).toHaveBeenCalledWith(
        webRouter,
        privateApiRouter,
        publicApiRouter
      )
    })

    it('starts all background workers via start()', async () => {
      const { default: module } = await import(INDEX)

      await module.start()

      expect(GoogleDrivePollingWorker.start).toHaveBeenCalled()
      expect(GoogleDriveOutboundWorker.start).toHaveBeenCalled()
      expect(GoogleDriveChannelRenewalWorker.start).toHaveBeenCalled()
      expect(GoogleDriveBulkSyncWorker.start).toHaveBeenCalled()
      expect(GoogleDriveImportWorker.start).toHaveBeenCalled()
    })

    it('ensures the job indexes when started', async () => {
      const { default: module } = await import(INDEX)

      await module.start()

      expect(ensureJobIndexes).toHaveBeenCalledTimes(1)
    })

    it('ensures the project-state indexes when started', async () => {
      const { default: module } = await import(INDEX)

      await module.start()

      expect(ensureProjectStateIndexes).toHaveBeenCalledTimes(1)
    })

    it('stops every worker during graceful shutdown', async () => {
      const { default: module } = await import(INDEX)

      await module.start()
      expect(addCleanupHandler).toHaveBeenCalledWith(
        'google-drive-sync',
        expect.any(Function)
      )
      const [, cleanup] = addCleanupHandler.mock.calls[0]
      cleanup()

      expect(GoogleDrivePollingWorker.stop).toHaveBeenCalled()
      expect(GoogleDriveOutboundWorker.stop).toHaveBeenCalled()
      expect(GoogleDriveChannelRenewalWorker.stop).toHaveBeenCalled()
      expect(GoogleDriveBulkSyncWorker.stop).toHaveBeenCalled()
      expect(GoogleDriveImportWorker.stop).toHaveBeenCalled()
    })

    it('forwards entity mutation hooks to GoogleDriveHookHandler', async () => {
      const { default: module } = await import(INDEX)
      const { promises: hooks } = module.hooks

      await hooks.fileModified('project-1', 'file-1', 'test.png', 'editor')
      expect(GoogleDriveHookHandler.onFileModified).toHaveBeenCalledWith(
        'project-1',
        'file-1',
        'test.png',
        'editor'
      )

      await hooks.entityDeleted('project-1', 'test.png', 'file', 'editor')
      expect(GoogleDriveHookHandler.onEntityDeleted).toHaveBeenCalledWith(
        'project-1',
        'test.png',
        'file',
        'editor'
      )

      const date = new Date()
      await hooks.docModified('project-1', 'doc-1', [], date)
      expect(GoogleDriveHookHandler.onDocModified).toHaveBeenCalledWith(
        'project-1',
        'doc-1',
        [],
        date
      )
    })
  })
})
