import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveOutboundWorker.mjs'

describe('GoogleDriveOutboundWorker', () => {
  let GoogleDriveOutboundWorker

  const Settings = {
    googleDrive: { outboundFlushSeconds: 600, outboundDebounceSeconds: 15 },
  }

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const Features = { hasFeature: vi.fn() }

  const db = {
    googleDriveProjectStates: {
      find: vi.fn(),
      updateOne: vi.fn(),
    },
  }

  const GoogleDriveSyncManager = {
    decodePathKey: vi.fn(k => String(k).replace(/%2E/g, '.')),
    acquireProjectLock: vi.fn(),
    releaseProjectLock: vi.fn(),
    recordSyncFailure: vi.fn(),
    clearSyncFailure: vi.fn(),
    handleOutboundDocUpdate: vi.fn(),
    handleOutboundFileUpdate: vi.fn(),
    handleOutboundDelete: vi.fn(),
  }

  const GoogleDriveClient = {
    getFileMetadata: vi.fn(),
  }

  const DocstoreManager = { promises: { getDoc: vi.fn() } }

  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs',
    () => ({ default: GoogleDriveClient, ...GoogleDriveClient })
  )
  vi.doMock(
    '../../../../../app/src/Features/Docstore/DocstoreManager.mjs',
    () => ({ default: DocstoreManager })
  )
  vi.doMock('@overleaf/settings', () => ({ default: Settings }))
  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs',
    () => ({ default: GoogleDriveSyncManager, ...GoogleDriveSyncManager })
  )

  const projectId = 'project-1'

  function mockCursor(docs) {
    return {
      async *[Symbol.asyncIterator]() {
        yield* docs
      },
    }
  }

  function stateWith(pendingChanges, overrides = {}) {
    return {
      projectId,
      userId: 'user-1',
      driveFolderId: 'folder-1',
      pendingChanges,
      outboundDirtyAt: new Date(Date.now() - 60000),
      ...overrides,
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    Features.hasFeature.mockReturnValue(true)
    GoogleDriveSyncManager.acquireProjectLock.mockResolvedValue(true)
    GoogleDriveSyncManager.handleOutboundDocUpdate.mockResolvedValue({
      success: true,
    })
    GoogleDriveSyncManager.handleOutboundFileUpdate.mockResolvedValue({
      success: true,
    })
    GoogleDriveSyncManager.handleOutboundDelete.mockResolvedValue({
      success: true,
    })
    GoogleDriveClient.getFileMetadata.mockResolvedValue(null)
    db.googleDriveProjectStates.updateOne.mockResolvedValue({})

    const mod = await import(modulePath)
    GoogleDriveOutboundWorker = mod.default
    GoogleDriveOutboundWorker.stop()
  })

  describe('flushProject', () => {
    it('pushes each pending path and removes it from the queue', async () => {
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
        'fig%2Epng': { op: 'upsert', entityType: 'file', entityId: 'file-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(
        GoogleDriveSyncManager.handleOutboundDocUpdate
      ).toHaveBeenCalledWith(projectId, 'doc-1', 'main.tex', undefined)
      expect(
        GoogleDriveSyncManager.handleOutboundFileUpdate
      ).toHaveBeenCalledWith(projectId, 'file-1', 'fig.png', undefined)

      const unsetKeys =
        db.googleDriveProjectStates.updateOne.mock.calls.flatMap(([, update]) =>
          Object.keys(update.$unset || {})
        )
      expect(unsetKeys).toContain('pendingChanges.main%2Etex')
      expect(unsetKeys).toContain('pendingChanges.fig%2Epng')
    })

    it('never performs a full project rescan', async () => {
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.syncProject).toBeUndefined()
    })

    it('skips a doc whose content already matches what Drive holds', async () => {
      // md5 of 'hello' — the loop guard for docModified, which carries no
      // source and so re-queues content we just pulled in from Drive.
      const md5 = '5d41402abc4b2a76b9719d911017c592'
      DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['hello'] })
      const state = stateWith(
        {
          'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
        },
        { fileMap: { 'main.tex': { md5Checksum: md5 } } }
      )

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(
        GoogleDriveSyncManager.handleOutboundDocUpdate
      ).not.toHaveBeenCalled()
      const unsetKeys =
        db.googleDriveProjectStates.updateOne.mock.calls.flatMap(([, update]) =>
          Object.keys(update.$unset || {})
        )
      expect(unsetKeys).toContain('pendingChanges.main%2Etex')
    })

    it('pushes a doc whose content has actually changed', async () => {
      DocstoreManager.promises.getDoc.mockResolvedValue({ lines: ['goodbye'] })
      const state = stateWith(
        {
          'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
        },
        { fileMap: { 'main.tex': { md5Checksum: 'stale-checksum' } } }
      )

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.handleOutboundDocUpdate).toHaveBeenCalled()
    })

    it('routes deletes to handleOutboundDelete', async () => {
      const state = stateWith({
        'old%2Epng': { op: 'delete', entityType: 'file' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.handleOutboundDelete).toHaveBeenCalledWith(
        projectId,
        'old.png'
      )
    })

    it('keeps a failed entry queued and increments its attempt count', async () => {
      GoogleDriveSyncManager.handleOutboundDocUpdate.mockRejectedValue(
        new Error('drive exploded')
      )
      const state = stateWith({
        'main%2Etex': {
          op: 'upsert',
          entityType: 'doc',
          entityId: 'doc-1',
          attempts: 1,
        },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      const attemptUpdate = db.googleDriveProjectStates.updateOne.mock.calls
        .map(([, update]) => update.$set)
        .find(set => set && set['pendingChanges.main%2Etex.attempts'] != null)
      expect(attemptUpdate['pendingChanges.main%2Etex.attempts']).toBe(2)

      const unsetKeys =
        db.googleDriveProjectStates.updateOne.mock.calls.flatMap(([, update]) =>
          Object.keys(update.$unset || {})
        )
      expect(unsetKeys).not.toContain('pendingChanges.main%2Etex')
    })

    it('drops an entry that has exhausted its attempts', async () => {
      GoogleDriveSyncManager.handleOutboundDocUpdate.mockRejectedValue(
        new Error('permanently broken')
      )
      const state = stateWith({
        'main%2Etex': {
          op: 'upsert',
          entityType: 'doc',
          entityId: 'doc-1',
          attempts: 5,
        },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      const unsetKeys =
        db.googleDriveProjectStates.updateOne.mock.calls.flatMap(([, update]) =>
          Object.keys(update.$unset || {})
        )
      expect(unsetKeys).toContain('pendingChanges.main%2Etex')
      expect(logger.error).toHaveBeenCalled()
    })

    it('records a backoff when Drive reports rate limiting', async () => {
      const err = new Error('quota')
      err.rateLimited = true
      GoogleDriveSyncManager.handleOutboundDocUpdate.mockRejectedValue(err)
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.recordSyncFailure).toHaveBeenCalledWith(
        projectId,
        err
      )
    })

    it('clears the failure state when the queue drains cleanly', async () => {
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.clearSyncFailure).toHaveBeenCalledWith(
        projectId
      )
    })

    it('skips the project entirely when the lock is held', async () => {
      GoogleDriveSyncManager.acquireProjectLock.mockResolvedValue(false)
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(
        GoogleDriveSyncManager.handleOutboundDocUpdate
      ).not.toHaveBeenCalled()
      expect(GoogleDriveSyncManager.releaseProjectLock).not.toHaveBeenCalled()
    })

    it('always releases the lock it acquired', async () => {
      GoogleDriveSyncManager.handleOutboundDocUpdate.mockRejectedValue(
        new Error('boom')
      )
      const state = stateWith({
        'main%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-1' },
      })

      await GoogleDriveOutboundWorker.flushProject(state)

      expect(GoogleDriveSyncManager.releaseProjectLock).toHaveBeenCalledWith(
        projectId
      )
    })

    describe('outbound divergence check', () => {
      it('calls getFileMetadata when mapped.driveFileId exists for an upsert change', async () => {
        GoogleDriveClient.getFileMetadata.mockResolvedValue({
          id: 'drive-file-1',
          md5Checksum: 'md5-same',
        })
        const state = stateWith(
          {
            'main%2Etex': {
              op: 'upsert',
              entityType: 'doc',
              entityId: 'doc-1',
            },
          },
          {
            fileMap: {
              'main.tex': {
                driveFileId: 'drive-file-1',
                md5Checksum: 'md5-same',
              },
            },
          }
        )
        DocstoreManager.promises.getDoc.mockResolvedValue({
          lines: ['modified content'],
        })

        await GoogleDriveOutboundWorker.flushProject(state)

        expect(GoogleDriveClient.getFileMetadata).toHaveBeenCalledWith(
          'user-1',
          'drive-file-1',
          'id,name,md5Checksum,trashed'
        )
        expect(
          GoogleDriveSyncManager.handleOutboundDocUpdate
        ).toHaveBeenCalledWith(projectId, 'doc-1', 'main.tex', undefined)
      })

      it('skips outbound push and retains change in pendingChanges when remote md5Checksum diverged', async () => {
        GoogleDriveClient.getFileMetadata.mockResolvedValue({
          id: 'drive-file-1',
          md5Checksum: 'remote-diverged-checksum',
        })
        const state = stateWith(
          {
            'main%2Etex': {
              op: 'upsert',
              entityType: 'doc',
              entityId: 'doc-1',
            },
          },
          {
            fileMap: {
              'main.tex': {
                driveFileId: 'drive-file-1',
                md5Checksum: 'local-last-synced-checksum',
              },
            },
          }
        )
        DocstoreManager.promises.getDoc.mockResolvedValue({
          lines: ['modified content'],
        })

        await GoogleDriveOutboundWorker.flushProject(state)

        expect(GoogleDriveClient.getFileMetadata).toHaveBeenCalledWith(
          'user-1',
          'drive-file-1',
          'id,name,md5Checksum,trashed'
        )
        expect(
          GoogleDriveSyncManager.handleOutboundDocUpdate
        ).not.toHaveBeenCalled()
        const unsetKeys =
          db.googleDriveProjectStates.updateOne.mock.calls.flatMap(
            ([, update]) => Object.keys(update.$unset || {})
          )
        expect(unsetKeys).not.toContain('pendingChanges.main%2Etex')
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ projectId, filePath: 'main.tex' }),
          expect.stringContaining('remote file diverged on Drive')
        )
      })
    })
  })

  describe('flushAll', () => {
    it('selects only settled, non-suspended, non-backed-off projects', async () => {
      db.googleDriveProjectStates.find.mockReturnValue(mockCursor([]))

      await GoogleDriveOutboundWorker.flushAll()

      const query = db.googleDriveProjectStates.find.mock.calls[0][0]
      expect(query.outboundDirtyAt.$lt).toBeInstanceOf(Date)
      expect(query.syncSuspended).toEqual({ $ne: true })
      expect(query.$or).toEqual(
        expect.arrayContaining([
          { backoffUntil: { $exists: false } },
          { backoffUntil: null },
          expect.objectContaining({ backoffUntil: expect.anything() }),
        ])
      )
    })

    it('applies the debounce window from settings', async () => {
      Settings.googleDrive.outboundDebounceSeconds = 30
      db.googleDriveProjectStates.find.mockReturnValue(mockCursor([]))

      await GoogleDriveOutboundWorker.flushAll()

      const query = db.googleDriveProjectStates.find.mock.calls[0][0]
      const windowMs = Date.now() - query.outboundDirtyAt.$lt.getTime()
      expect(windowMs).toBeGreaterThan(29000)
      expect(windowMs).toBeLessThan(31000)
    })

    it('does nothing when the feature is disabled', async () => {
      Features.hasFeature.mockReturnValue(false)

      await GoogleDriveOutboundWorker.flushAll()

      expect(db.googleDriveProjectStates.find).not.toHaveBeenCalled()
    })

    it('continues past a project that throws', async () => {
      const bad = stateWith({
        'a%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-a' },
      })
      const good = stateWith(
        { 'b%2Etex': { op: 'upsert', entityType: 'doc', entityId: 'doc-b' } },
        { projectId: 'project-2' }
      )
      db.googleDriveProjectStates.find.mockReturnValue(mockCursor([bad, good]))
      GoogleDriveSyncManager.acquireProjectLock
        .mockRejectedValueOnce(new Error('lock blew up'))
        .mockResolvedValue(true)

      await GoogleDriveOutboundWorker.flushAll()

      expect(logger.error).toHaveBeenCalled()
      expect(
        GoogleDriveSyncManager.handleOutboundDocUpdate
      ).toHaveBeenCalledWith('project-2', 'doc-b', 'b.tex', undefined)
    })
  })

  describe('start / stop', () => {
    it('does not start a timer when the feature is disabled', () => {
      Features.hasFeature.mockReturnValue(false)
      GoogleDriveOutboundWorker.start()
      expect(logger.info).not.toHaveBeenCalled()
    })

    it('starts only once', () => {
      GoogleDriveOutboundWorker.start()
      GoogleDriveOutboundWorker.start()
      expect(logger.info).toHaveBeenCalledTimes(1)
      GoogleDriveOutboundWorker.stop()
    })
  })
})
