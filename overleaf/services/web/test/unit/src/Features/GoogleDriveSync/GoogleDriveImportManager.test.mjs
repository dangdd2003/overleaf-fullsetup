import { describe, it, beforeEach, vi, expect } from 'vitest'
import { ObjectId } from 'mongodb-legacy'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveImportManager.mjs'

describe('GoogleDriveImportManager', () => {
  let GoogleDriveImportManager

  const userId = new ObjectId()
  const folderA = { id: 'folder-1', name: 'Thesis' }
  const folderB = { id: 'folder-2', name: 'Paper' }
  const rootFolderId = 'root-folder-123'

  const GoogleDriveClient = {
    getOrCreateRootFolder: vi.fn(),
    listFiles: vi.fn(),
  }

  const db = {
    googleDriveImportJobs: {
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
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs',
    () => ({ default: GoogleDriveClient })
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
    GoogleDriveClient.listFiles.mockResolvedValue({
      files: [folderA, folderB],
      nextPageToken: null,
    })
    db.googleDriveProjectStates.find.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          projectId: new ObjectId(),
          driveFolderId: folderA.id,
          lastSyncedAt: new Date('2026-09-01'),
        },
      ]),
    })
    const mod = await import(modulePath)
    GoogleDriveImportManager = mod.default
  })

  describe('listImportableFolders', () => {
    it('fast-lists folders under root folder with linked status', async () => {
      const folders =
        await GoogleDriveImportManager.listImportableFolders(userId)

      expect(folders.map(f => f.name)).toEqual(['Paper', 'Thesis'])
      expect(folders.find(f => f.folderId === folderA.id)).toMatchObject({
        folderId: folderA.id,
        name: folderA.name,
        linked: true,
        lastSyncedAt: new Date('2026-09-01'),
      })
      expect(folders.find(f => f.folderId === folderB.id)).toMatchObject({
        folderId: folderB.id,
        name: folderB.name,
        linked: false,
        projectId: null,
        lastSyncedAt: null,
      })
    })
  })

  describe('createImportJob', () => {
    it('creates a queued active import job for valid folders', async () => {
      const insertedId = new ObjectId()
      db.googleDriveImportJobs.insertOne.mockResolvedValue({ insertedId })

      const job = await GoogleDriveImportManager.createImportJob(userId, [
        folderA.id,
        folderB.id,
      ])

      expect(job._id).toBe(insertedId)
      const inserted = db.googleDriveImportJobs.insertOne.mock.calls[0][0]
      expect(inserted).toMatchObject({
        userId,
        status: 'queued',
        active: true,
      })
      expect(inserted.folders).toEqual([
        {
          folderId: folderA.id,
          name: folderA.name,
          status: 'queued',
          projectId: expect.anything(),
        },
        {
          folderId: folderB.id,
          name: folderB.name,
          status: 'queued',
          projectId: null,
        },
      ])
    })

    it('rejects an empty selection', async () => {
      const err = await GoogleDriveImportManager.createImportJob(
        userId,
        []
      ).catch(e => e)
      expect(err).toBeInstanceOf(
        GoogleDriveImportManager.InvalidImportRequestError
      )
      expect(db.googleDriveImportJobs.insertOne).not.toHaveBeenCalled()
    })

    it('rejects folders not present in user Drive', async () => {
      const err = await GoogleDriveImportManager.createImportJob(userId, [
        'non-existent-folder',
      ]).catch(e => e)
      expect(err).toBeInstanceOf(
        GoogleDriveImportManager.InvalidImportRequestError
      )
      expect(db.googleDriveImportJobs.insertOne).not.toHaveBeenCalled()
    })

    it('throws ImportJobAlreadyRunningError on duplicate key error (11000)', async () => {
      db.googleDriveImportJobs.insertOne.mockRejectedValue(
        Object.assign(new Error('E11000'), { code: 11000 })
      )

      const err = await GoogleDriveImportManager.createImportJob(userId, [
        folderA.id,
      ]).catch(e => e)
      expect(err).toBeInstanceOf(
        GoogleDriveImportManager.ImportJobAlreadyRunningError
      )
    })
  })

  describe('getLatestJob', () => {
    it('prefers the active job', async () => {
      const active = { _id: new ObjectId(), active: true }
      db.googleDriveImportJobs.findOne.mockResolvedValueOnce(active)

      const job = await GoogleDriveImportManager.getLatestJob(userId)

      expect(job).toBe(active)
      expect(db.googleDriveImportJobs.findOne).toHaveBeenCalledTimes(1)
    })

    it('falls back to the most recent job', async () => {
      const finished = { _id: new ObjectId(), status: 'completed' }
      db.googleDriveImportJobs.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(finished)

      const job = await GoogleDriveImportManager.getLatestJob(userId)

      expect(job).toBe(finished)
      expect(db.googleDriveImportJobs.findOne.mock.calls[1][1]).toEqual({
        sort: { createdAt: -1 },
      })
    })
  })

  describe('cancelActiveJobs', () => {
    it('marks active jobs cancelled and unsets active flag', async () => {
      await GoogleDriveImportManager.cancelActiveJobs(userId.toString())

      const [query, update] =
        db.googleDriveImportJobs.updateMany.mock.calls[0]
      expect(query.userId.toString()).toBe(userId.toString())
      expect(query.active).toBe(true)
      expect(update.$set.status).toBe('cancelled')
      expect(update.$unset).toEqual({ active: '', leaseExpiresAt: '' })
    })
  })

  describe('serializeJob', () => {
    it('summarizes folder outcomes', () => {
      const job = {
        _id: new ObjectId(),
        status: 'running',
        createdAt: new Date(),
        folders: [
          {
            folderId: 'f-1',
            name: 'Thesis',
            status: 'synced',
            projectId: new ObjectId(),
          },
          {
            folderId: 'f-2',
            name: 'Paper',
            status: 'failed',
            error: 'Not found',
          },
        ],
      }

      expect(GoogleDriveImportManager.serializeJob(job)).toMatchObject({
        id: job._id.toString(),
        status: 'running',
        total: 2,
        importedCount: 1,
        failedCount: 1,
        folders: [
          { folderId: 'f-1', name: 'Thesis', status: 'synced', error: null },
          { folderId: 'f-2', name: 'Paper', status: 'failed', error: 'Not found' },
        ],
      })
    })

    it('returns null without a job', () => {
      expect(GoogleDriveImportManager.serializeJob(null)).toBeNull()
    })
  })
})
