import { describe, it, beforeEach, vi, expect } from 'vitest'
import { ObjectId } from 'mongodb-legacy'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveBulkSyncManager.mjs'

describe('GoogleDriveBulkSyncManager', () => {
  let GoogleDriveBulkSyncManager

  const userId = new ObjectId()
  const otherUserId = new ObjectId()
  const projectA = { _id: new ObjectId(), name: 'Thesis', lastUpdated: 2 }
  const projectB = { _id: new ObjectId(), name: 'Paper', lastUpdated: 3 }
  const trashedProject = {
    _id: new ObjectId(),
    name: 'Old',
    trashed: [userId],
  }
  const trashedByOther = {
    _id: new ObjectId(),
    name: 'Kept',
    lastUpdated: 1,
    trashed: [otherUserId],
  }

  const ProjectGetter = {
    promises: { findAllUsersProjects: vi.fn() },
  }

  const db = {
    googleDriveBulkSyncJobs: {
      insertOne: vi.fn(),
      findOne: vi.fn(),
      updateMany: vi.fn(),
    },
    googleDriveProjectStates: {
      find: vi.fn(),
    },
  }

  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
    ObjectId,
  }))
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectGetter.mjs',
    () => ({ default: ProjectGetter })
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    ProjectGetter.promises.findAllUsersProjects.mockResolvedValue({
      owned: [projectA, projectB, trashedProject, trashedByOther],
      readAndWrite: [{ _id: new ObjectId(), name: 'Shared' }],
    })
    db.googleDriveProjectStates.find.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          projectId: projectA._id,
          driveFolderId: 'folder-a',
          lastSyncedAt: new Date('2026-09-01'),
        },
      ]),
    })
    const mod = await import(modulePath)
    GoogleDriveBulkSyncManager = mod.default
  })

  describe('listSyncableProjects', () => {
    it('lists owned, untrashed projects newest first with drive state', async () => {
      const projects =
        await GoogleDriveBulkSyncManager.listSyncableProjects(userId)

      expect(projects.map(p => p.name)).toEqual(['Paper', 'Thesis', 'Kept'])
      expect(projects[1]).toMatchObject({
        id: projectA._id.toString(),
        linked: true,
        lastSyncedAt: new Date('2026-09-01'),
      })
      expect(projects[0]).toMatchObject({ linked: false, lastSyncedAt: null })
    })
  })

  describe('createJob', () => {
    it('inserts a queued active job for the selected projects', async () => {
      const insertedId = new ObjectId()
      db.googleDriveBulkSyncJobs.insertOne.mockResolvedValue({ insertedId })

      const job = await GoogleDriveBulkSyncManager.createJob(userId, [
        projectA._id.toString(),
        projectB._id.toString(),
        projectA._id.toString(),
      ])

      expect(job._id).toBe(insertedId)
      const inserted = db.googleDriveBulkSyncJobs.insertOne.mock.calls[0][0]
      expect(inserted).toMatchObject({
        userId,
        status: 'queued',
        active: true,
      })
      expect(inserted.projects).toEqual([
        { projectId: projectA._id, name: 'Thesis', status: 'queued' },
        { projectId: projectB._id, name: 'Paper', status: 'queued' },
      ])
    })

    it('rejects an empty selection', async () => {
      const err = await GoogleDriveBulkSyncManager.createJob(userId, []).catch(
        e => e
      )
      expect(err).toBeInstanceOf(
        GoogleDriveBulkSyncManager.InvalidBulkSyncRequestError
      )
      expect(db.googleDriveBulkSyncJobs.insertOne).not.toHaveBeenCalled()
    })

    it('rejects projects the user does not own or has trashed', async () => {
      const err = await GoogleDriveBulkSyncManager.createJob(userId, [
        projectA._id.toString(),
        trashedProject._id.toString(),
      ]).catch(e => e)
      expect(err).toBeInstanceOf(
        GoogleDriveBulkSyncManager.InvalidBulkSyncRequestError
      )
      expect(db.googleDriveBulkSyncJobs.insertOne).not.toHaveBeenCalled()
    })

    it('reports an already running job on a duplicate key error', async () => {
      db.googleDriveBulkSyncJobs.insertOne.mockRejectedValue(
        Object.assign(new Error('E11000'), { code: 11000 })
      )

      const err = await GoogleDriveBulkSyncManager.createJob(userId, [
        projectA._id.toString(),
      ]).catch(e => e)
      expect(err).toBeInstanceOf(
        GoogleDriveBulkSyncManager.BulkSyncAlreadyRunningError
      )
    })
  })

  describe('getLatestJob', () => {
    it('prefers the active job', async () => {
      const active = { _id: new ObjectId(), active: true }
      db.googleDriveBulkSyncJobs.findOne.mockResolvedValueOnce(active)

      const job = await GoogleDriveBulkSyncManager.getLatestJob(userId)

      expect(job).toBe(active)
      expect(db.googleDriveBulkSyncJobs.findOne).toHaveBeenCalledTimes(1)
    })

    it('falls back to the most recent job', async () => {
      const finished = { _id: new ObjectId(), status: 'completed' }
      db.googleDriveBulkSyncJobs.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(finished)

      const job = await GoogleDriveBulkSyncManager.getLatestJob(userId)

      expect(job).toBe(finished)
      expect(db.googleDriveBulkSyncJobs.findOne.mock.calls[1][1]).toEqual({
        sort: { createdAt: -1 },
      })
    })
  })

  describe('cancelActiveJobs', () => {
    it('marks active jobs cancelled and releases the active slot', async () => {
      await GoogleDriveBulkSyncManager.cancelActiveJobs(userId.toString())

      const [query, update] =
        db.googleDriveBulkSyncJobs.updateMany.mock.calls[0]
      expect(query.userId.toString()).toBe(userId.toString())
      expect(query.active).toBe(true)
      expect(update.$set.status).toBe('cancelled')
      expect(update.$unset).toEqual({ active: '', leaseExpiresAt: '' })
    })
  })

  describe('serializeJob', () => {
    it('summarises project outcomes', () => {
      const job = {
        _id: new ObjectId(),
        status: 'running',
        createdAt: new Date(),
        projects: [
          { projectId: projectA._id, name: 'Thesis', status: 'synced' },
          {
            projectId: projectB._id,
            name: 'Paper',
            status: 'failed',
            error: 'boom',
          },
        ],
      }

      expect(GoogleDriveBulkSyncManager.serializeJob(job)).toMatchObject({
        id: job._id.toString(),
        status: 'running',
        total: 2,
        syncedCount: 1,
        failedCount: 1,
        projects: [
          { projectId: projectA._id.toString(), status: 'synced', error: null },
          {
            projectId: projectB._id.toString(),
            status: 'failed',
            error: 'boom',
          },
        ],
      })
    })

    it('returns null without a job', () => {
      expect(GoogleDriveBulkSyncManager.serializeJob(null)).toBeNull()
    })
  })
})
