import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveHookHandler.mjs'

describe('GoogleDriveHookHandler', () => {
  let GoogleDriveHookHandler

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const Features = { hasFeature: vi.fn() }

  const db = {
    googleDriveProjectStates: {
      findOne: vi.fn(),
      updateOne: vi.fn(),
    },
  }

  const GoogleDriveSyncManager = {
    isIgnoredFile: vi.fn(),
    normalizePath: vi.fn(p => String(p).replace(/^\/+/, '')),
    encodePathKey: vi.fn(p => String(p).replace(/\./g, '%2E')),
  }

  const ProjectEntityHandler = {
    promises: { getDocPathByProjectIdAndDocId: vi.fn() },
  }

  class MockObjectId {
    constructor(id) {
      this.id = id
      this._bsontype = 'ObjectID'
    }
    toString() {
      return this.id.toString()
    }
    static isValid(id) {
      return typeof id === 'string' && id.length === 24
    }
  }

  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
    ObjectId: MockObjectId,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs',
    () => ({ default: GoogleDriveSyncManager, ...GoogleDriveSyncManager })
  )
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
    () => ({ default: ProjectEntityHandler })
  )

  const projectId = 'project-1'
  const entityId = 'entity-1'

  beforeEach(async () => {
    vi.clearAllMocks()
    Features.hasFeature.mockReturnValue(true)
    GoogleDriveSyncManager.isIgnoredFile.mockReturnValue(false)
    db.googleDriveProjectStates.findOne.mockResolvedValue({ projectId })
    db.googleDriveProjectStates.updateOne.mockResolvedValue({})
    ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId.mockResolvedValue(
      '/main.tex'
    )

    const mod = await import(modulePath)
    GoogleDriveHookHandler = mod.default
  })

  describe('onFileModified', () => {
    it('queues an upsert for the changed path', async () => {
      await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.tex',
        'editor'
      )

      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledTimes(1)
      const [query, update] =
        db.googleDriveProjectStates.updateOne.mock.calls[0]
      expect(query.projectId).toBeDefined()
      expect(update.$set['pendingChanges.main%2Etex'].op).toBe('upsert')
      expect(update.$set['pendingChanges.main%2Etex'].entityId).toBe(entityId)
      expect(update.$set.outboundDirtyAt).toBeInstanceOf(Date)
    })

    it('does nothing when the feature is disabled', async () => {
      Features.hasFeature.mockReturnValue(false)

      await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.tex',
        'editor'
      )

      expect(db.googleDriveProjectStates.findOne).not.toHaveBeenCalled()
      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('ignores changes that originated from Google Drive', async () => {
      await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.tex',
        'google-drive'
      )

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('ignores LaTeX build artefacts', async () => {
      GoogleDriveSyncManager.isIgnoredFile.mockReturnValue(true)

      await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.aux',
        'editor'
      )

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('does nothing when the project is not linked to Drive', async () => {
      db.googleDriveProjectStates.findOne.mockResolvedValue(null)

      await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.tex',
        'editor'
      )

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('never throws, so a sync bookkeeping error cannot fail the edit', async () => {
      db.googleDriveProjectStates.updateOne.mockRejectedValue(
        new Error('mongo down')
      )

      const result = await GoogleDriveHookHandler.onFileModified(
        projectId,
        entityId,
        '/main.tex',
        'editor'
      )
      expect(result).toBeUndefined()
      expect(logger.error).toHaveBeenCalled()
    })
  })

  describe('onEntityDeleted', () => {
    it('queues a delete for the removed path', async () => {
      await GoogleDriveHookHandler.onEntityDeleted(
        projectId,
        '/figures/old.png',
        'file',
        'editor'
      )

      const [, update] = db.googleDriveProjectStates.updateOne.mock.calls[0]
      const entry = update.$set['pendingChanges.figures/old%2Epng']
      expect(entry.op).toBe('delete')
      expect(entry.entityType).toBe('file')
    })

    it('ignores deletes that originated from Google Drive', async () => {
      await GoogleDriveHookHandler.onEntityDeleted(
        projectId,
        '/figures/old.png',
        'file',
        'google-drive'
      )

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })
  })

  describe('onDocModified', () => {
    it('resolves the doc path and queues a doc upsert', async () => {
      ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId.mockResolvedValue(
        '/chapters/intro.tex'
      )

      await GoogleDriveHookHandler.onDocModified(projectId, 'doc-9', null, null)

      const [, update] = db.googleDriveProjectStates.updateOne.mock.calls[0]
      const entry = update.$set['pendingChanges.chapters/intro%2Etex']
      expect(entry.op).toBe('upsert')
      expect(entry.entityType).toBe('doc')
      expect(entry.entityId).toBe('doc-9')
    })

    it('checks the project is linked before resolving the path', async () => {
      // Path resolution loads the whole project; skip it for unlinked projects.
      db.googleDriveProjectStates.findOne.mockResolvedValue(null)

      await GoogleDriveHookHandler.onDocModified(projectId, 'doc-9', null, null)

      expect(
        ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId
      ).not.toHaveBeenCalled()
      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('does nothing when the feature is disabled', async () => {
      Features.hasFeature.mockReturnValue(false)

      await GoogleDriveHookHandler.onDocModified(projectId, 'doc-9', null, null)

      expect(db.googleDriveProjectStates.findOne).not.toHaveBeenCalled()
    })

    it('ignores a doc whose path resolves to a build artefact', async () => {
      ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId.mockResolvedValue(
        '/main.aux'
      )
      GoogleDriveSyncManager.isIgnoredFile.mockReturnValue(true)

      await GoogleDriveHookHandler.onDocModified(projectId, 'doc-9', null, null)

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })

    it('never throws when the path cannot be resolved', async () => {
      ProjectEntityHandler.promises.getDocPathByProjectIdAndDocId.mockRejectedValue(
        new Error('doc not in project')
      )

      const result = await GoogleDriveHookHandler.onDocModified(
        projectId,
        'doc-9',
        null,
        null
      )
      expect(result).toBeUndefined()
      expect(logger.error).toHaveBeenCalled()
    })
  })
})
