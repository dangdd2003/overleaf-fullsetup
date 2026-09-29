import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveBulkSyncWorker.mjs'

describe('GoogleDriveBulkSyncWorker', () => {
  let GoogleDriveBulkSyncWorker

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const GoogleDriveSyncManager = {
    syncProject: vi.fn(),
  }

  const db = {
    googleDriveBulkSyncJobs: {
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
    },
    googleDriveProjectStates: {
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
      projects: statuses.map((status, i) => ({
        projectId: `project-${i}`,
        name: `Project ${i}`,
        status,
      })),
    }
  }

  // Updates guarded by `active: true` are the ones that notice cancellation
  function guardedUpdates() {
    return db.googleDriveBulkSyncJobs.updateOne.mock.calls.filter(
      ([query]) => query.active === true
    )
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    db.googleDriveBulkSyncJobs.updateOne.mockResolvedValue({ matchedCount: 1 })
    db.googleDriveProjectStates.updateOne.mockResolvedValue({})
    GoogleDriveSyncManager.syncProject.mockResolvedValue({ success: true })
    const mod = await import(modulePath)
    GoogleDriveBulkSyncWorker = mod.default
  })

  it('syncs each remaining project and completes the job', async () => {
    const job = makeJob(['synced', 'queued', 'syncing'])

    await GoogleDriveBulkSyncWorker.processJob(job)

    // The already-synced project is skipped; one interrupted mid-sync resumes
    expect(GoogleDriveSyncManager.syncProject.mock.calls).toEqual([
      ['project-1', 'user-1'],
      ['project-2', 'user-1'],
    ])
    expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
      { projectId: 'project-1' },
      { $set: { pendingChanges: {} }, $unset: { outboundDirtyAt: '' } }
    )
    expect(db.googleDriveBulkSyncJobs.updateOne).toHaveBeenCalledWith(
      { _id: 'job-1' },
      { $set: { 'projects.1.status': 'synced' } }
    )
    const finalUpdate = guardedUpdates().at(-1)[1]
    expect(finalUpdate.$set.status).toBe('completed')
    expect(finalUpdate.$unset).toEqual({ active: '', leaseExpiresAt: '' })
  })

  it('records a failed project and carries on with the rest', async () => {
    const job = makeJob(['queued', 'queued'])
    GoogleDriveSyncManager.syncProject
      .mockRejectedValueOnce(new Error('Drive quota exceeded'))
      .mockResolvedValueOnce({ success: true })

    await GoogleDriveBulkSyncWorker.processJob(job)

    expect(db.googleDriveBulkSyncJobs.updateOne).toHaveBeenCalledWith(
      { _id: 'job-1' },
      {
        $set: {
          'projects.0.status': 'failed',
          'projects.0.error': 'Drive quota exceeded',
        },
      }
    )
    expect(GoogleDriveSyncManager.syncProject).toHaveBeenCalledTimes(2)
    expect(guardedUpdates().at(-1)[1].$set.status).toBe('completed')
  })

  it('retries when the project lock is held', async () => {
    const job = makeJob(['queued'])
    GoogleDriveSyncManager.syncProject
      .mockRejectedValueOnce(
        new Error('Could not acquire project lock for Google Drive sync')
      )
      .mockResolvedValueOnce({ success: true })

    await GoogleDriveBulkSyncWorker.processJob(job)

    expect(GoogleDriveSyncManager.syncProject).toHaveBeenCalledTimes(2)
    expect(db.googleDriveBulkSyncJobs.updateOne).toHaveBeenCalledWith(
      { _id: 'job-1' },
      { $set: { 'projects.0.status': 'synced' } }
    )
  })

  it('aborts the entire job immediately if token decryption fails', async () => {
    const job = makeJob(['queued', 'queued', 'queued'])
    const decryptErr = new Error('Failed to decrypt token: authentication tag verification failed')
    decryptErr.code = 'token_decryption_failed'
    GoogleDriveSyncManager.syncProject.mockRejectedValueOnce(decryptErr)

    await GoogleDriveBulkSyncWorker.processJob(job)

    // Should only attempt the first project and abort without trying project 1 or 2
    expect(GoogleDriveSyncManager.syncProject).toHaveBeenCalledTimes(1)
    const abortUpdate = db.googleDriveBulkSyncJobs.updateOne.mock.calls.find(
      ([query, update]) => query._id === 'job-1' && update.$set?.status === 'failed'
    )
    expect(abortUpdate).toBeDefined()
    expect(abortUpdate[1].$set.error).toMatch(/Google Drive authorization has expired or changed/)
    expect(abortUpdate[1].$unset).toEqual({ active: '', leaseExpiresAt: '' })
  })

  it('stops before the next project once the job is cancelled', async () => {
    const job = makeJob(['queued', 'queued'])
    db.googleDriveBulkSyncJobs.updateOne.mockImplementation(async query =>
      query.active === true &&
      GoogleDriveSyncManager.syncProject.mock.calls.length > 0
        ? { matchedCount: 0 }
        : { matchedCount: 1 }
    )

    await GoogleDriveBulkSyncWorker.processJob(job)

    expect(GoogleDriveSyncManager.syncProject).toHaveBeenCalledTimes(1)
    const completed = guardedUpdates().some(
      ([, update]) => update.$set?.status === 'completed'
    )
    expect(completed).toBe(false)
  })

  it('kick claims queued jobs', async () => {
    db.googleDriveBulkSyncJobs.findOneAndUpdate
      .mockResolvedValueOnce(makeJob(['queued']))
      .mockResolvedValue(null)

    GoogleDriveBulkSyncWorker.kick()

    await vi.waitFor(() => {
      expect(GoogleDriveSyncManager.syncProject).toHaveBeenCalledWith(
        'project-0',
        'user-1'
      )
    })
    const [query, update] =
      db.googleDriveBulkSyncJobs.findOneAndUpdate.mock.calls[0]
    expect(query.active).toBe(true)
    expect(update.$set.status).toBe('running')
  })
})
