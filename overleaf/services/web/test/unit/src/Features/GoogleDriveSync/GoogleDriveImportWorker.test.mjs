import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveImportWorker.mjs'

describe('GoogleDriveImportWorker', () => {
  let GoogleDriveImportWorker

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const GoogleDriveSyncManager = {
    syncProject: vi.fn(),
    downloadDriveFolderToOverleaf: vi.fn(),
    _createProjectFromDriveFolder: vi.fn(),
  }

  const db = {
    googleDriveImportJobs: {
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
    },
    googleDriveProjectStates: {
      findOne: vi.fn(),
      updateOne: vi.fn(),
    },
  }

  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('@overleaf/settings', () => ({ default: { googleDrive: {} } }))
  vi.doMock('node:timers/promises', () => ({ setTimeout: vi.fn() }))
  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: { hasFeature: () => true },
  }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs',
    () => ({ default: GoogleDriveSyncManager })
  )

  function makeJob(statuses) {
    return {
      _id: 'job-1',
      userId: 'user-1',
      folders: statuses.map((status, i) => ({
        folderId: `folder-${i}`,
        name: `Folder ${i}`,
        status,
      })),
    }
  }

  function guardedUpdates() {
    return db.googleDriveImportJobs.updateOne.mock.calls.filter(
      ([query]) => query.active === true
    )
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    db.googleDriveImportJobs.updateOne.mockResolvedValue({ matchedCount: 1 })
    db.googleDriveProjectStates.findOne.mockResolvedValue(null)
    GoogleDriveSyncManager.syncProject.mockResolvedValue({ success: true })
    GoogleDriveSyncManager._createProjectFromDriveFolder.mockResolvedValue({
      projectId: 'new-project-id',
      folderName: 'New Project',
    })
    const mod = await import(modulePath)
    GoogleDriveImportWorker = mod.default
  })

  it('imports new folders and syncs existing linked ones', async () => {
    const job = makeJob(['synced', 'queued', 'queued'])
    // Folder 1 is existing/linked
    db.googleDriveProjectStates.findOne.mockResolvedValueOnce({
      projectId: 'existing-proj-1',
      driveFolderId: 'folder-1',
    })
    // Folder 2 is new
    db.googleDriveProjectStates.findOne.mockResolvedValueOnce(null)

    await GoogleDriveImportWorker.processJob(job)

    // Folder 0 skipped (already synced)
    // Folder 1 synced
    expect(GoogleDriveSyncManager.downloadDriveFolderToOverleaf).toHaveBeenCalledWith(
      'existing-proj-1',
      'user-1',
      'folder-1'
    )
    // Folder 2 created as new project
    expect(GoogleDriveSyncManager._createProjectFromDriveFolder).toHaveBeenCalledWith(
      'user-1',
      'user-1',
      { id: 'folder-2', name: 'Folder 2' }
    )

    const finalUpdate = guardedUpdates().at(-1)[1]
    expect(finalUpdate.$set.status).toBe('completed')
    expect(finalUpdate.$unset).toEqual({ active: '', leaseExpiresAt: '' })
  })

  it('records failed folder and continues with the rest', async () => {
    const job = makeJob(['queued', 'queued'])
    GoogleDriveSyncManager._createProjectFromDriveFolder
      .mockRejectedValueOnce(new Error('Folder corrupted'))
      .mockResolvedValueOnce({ projectId: 'new-proj-2' })

    await GoogleDriveImportWorker.processJob(job)

    expect(db.googleDriveImportJobs.updateOne).toHaveBeenCalledWith(
      { _id: 'job-1' },
      {
        $set: {
          'folders.0.status': 'failed',
          'folders.0.error': 'Folder corrupted',
        },
      }
    )
    expect(GoogleDriveSyncManager._createProjectFromDriveFolder).toHaveBeenCalledTimes(2)
    expect(guardedUpdates().at(-1)[1].$set.status).toBe('completed')
  })

  it('aborts immediately if token decryption fails', async () => {
    const job = makeJob(['queued', 'queued'])
    const err = new Error('Failed to decrypt token: authentication tag verification failed')
    err.code = 'token_decryption_failed'
    GoogleDriveSyncManager._createProjectFromDriveFolder.mockRejectedValueOnce(err)

    await GoogleDriveImportWorker.processJob(job)

    expect(GoogleDriveSyncManager._createProjectFromDriveFolder).toHaveBeenCalledTimes(1)
    const abortUpdate = db.googleDriveImportJobs.updateOne.mock.calls.find(
      ([query, update]) => query._id === 'job-1' && update.$set?.status === 'failed'
    )
    expect(abortUpdate).toBeDefined()
    expect(abortUpdate[1].$set.error).toMatch(/Google Drive authorization has expired or changed/)
    expect(abortUpdate[1].$unset).toEqual({ active: '', leaseExpiresAt: '' })
  })

  it('stops before the next folder once the job is cancelled', async () => {
    const job = makeJob(['queued', 'queued'])
    db.googleDriveImportJobs.updateOne.mockImplementation(async query =>
      query.active === true &&
      GoogleDriveSyncManager._createProjectFromDriveFolder.mock.calls.length > 0
        ? { matchedCount: 0 }
        : { matchedCount: 1 }
    )

    await GoogleDriveImportWorker.processJob(job)

    expect(GoogleDriveSyncManager._createProjectFromDriveFolder).toHaveBeenCalledTimes(1)
    const completed = guardedUpdates().some(
      ([, update]) => update.$set?.status === 'completed'
    )
    expect(completed).toBe(false)
  })

  it('kick claims queued jobs', async () => {
    db.googleDriveImportJobs.findOneAndUpdate
      .mockResolvedValueOnce(makeJob(['queued']))
      .mockResolvedValue(null)

    GoogleDriveImportWorker.kick()

    await vi.waitFor(() => {
      expect(GoogleDriveSyncManager._createProjectFromDriveFolder).toHaveBeenCalledWith(
        'user-1',
        'user-1',
        { id: 'folder-0', name: 'Folder 0' }
      )
    })
  })
})
