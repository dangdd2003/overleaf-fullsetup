import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Settings from '@overleaf/settings'
import { DEFAULTS, mergePlain } from '../../../app/src/TemplateGalleryDefaults.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import Lock from '../../../app/src/jobs/Lock.mjs'
import JobStore from '../../../app/src/jobs/JobStore.mjs'
import SandboxGate from '../../../app/src/validation/SandboxGate.mjs'
import UserDeletion from '../../../app/src/hooks/UserDeletion.mjs'
import { detectGitRepoUrl } from '../../../app/src/services/tiers/Tier2GitAcquisition.mjs'
import TemplateSourceAcquisitionService from '../../../app/src/services/TemplateSourceAcquisitionService.mjs'
import Lifecycle from '../../../app/src/Lifecycle.mjs'

describe('Lock, JobStore, SandboxGate & UserDeletion Hooks', () => {
  beforeEach(() => {
    Settings.enableTemplateGallery = true
    Settings.templateGallery = mergePlain(DEFAULTS, {})
  })

  afterEach(() => {
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
  })

  it('acquires, renews, pauses, resumes, and handles E11000 contention in Lock', async () => {
    let lockDoc = null
    const mockLocksCol = {
      updateOne: vi.fn(async (filter, update, opts) => {
        if (!lockDoc && opts?.upsert) {
          lockDoc = { _id: filter._id, ...(update.$set || {}) }
          return { matchedCount: 0, upsertedCount: 1 }
        }
        if (
          filter.$or &&
          lockDoc &&
          lockDoc.leaseOwner &&
          lockDoc.leaseOwner !== update.$set?.leaseOwner &&
          lockDoc.leaseExpiresAt > Date.now()
        ) {
          const dupErr = new Error('E11000 duplicate key')
          dupErr.code = 11000
          throw dupErr
        }
        lockDoc = { ...(lockDoc || {}), ...(update.$set || {}) }
        return { matchedCount: 1, modifiedCount: 1 }
      }),
      findOne: vi.fn(async () => lockDoc),
    }
    setCollectionOverrideForTests({ templateGalleryLocks: mockLocksCol })

    const won1 = await Lock.acquire('validator', 'worker-1', Date.now(), 60_000)
    expect(won1).toBe(true)

    const won2 = await Lock.acquire('validator', 'worker-2', Date.now(), 60_000)
    expect(won2).toBe(false)

    await Lock.pause('validator', 'admin-1')
    const state = await Lock.read('validator')
    expect(state.paused).toBe(true)

    await Lock.resume('validator')
    const stateAfter = await Lock.read('validator')
    expect(stateAfter.paused).toBe(false)
  })

  it('enqueues with dedupeKey, enforces queueCap, and computes exponential backoff in JobStore', async () => {
    const jobs = []
    const mockJobsCol = {
      findOne: vi.fn(async filter => {
        if (filter.dedupeKey) {
          return jobs.find(j => j.dedupeKey === filter.dedupeKey && (j.state === 'queued' || j.state === 'running')) || null
        }
        return null
      }),
      countDocuments: vi.fn(async () => jobs.filter(j => j.state === 'queued').length),
      insertOne: vi.fn(async doc => {
        const stored = { _id: `job-${jobs.length + 1}`, ...doc }
        jobs.push(stored)
        return { insertedId: stored._id }
      }),
    }
    setCollectionOverrideForTests({ templateGalleryJobs: mockJobsCol })

    const j1 = await JobStore.enqueue(
      { kind: 'validate', itemId: 'item-1', dedupeKey: 'validate:item-1' },
      DEFAULTS
    )
    const j2 = await JobStore.enqueue(
      { kind: 'validate', itemId: 'item-1', dedupeKey: 'validate:item-1' },
      DEFAULTS
    )
    expect(j1._id).toBe(j2._id)
    expect(jobs).toHaveLength(1)

    expect(JobStore.backoffMs(1, 60_000)).toBe(60_000)
    expect(JobStore.backoffMs(2, 60_000)).toBe(120_000)
    expect(JobStore.backoffMs(3, 60_000)).toBe(240_000)
  })

  it('enforces SandboxGate modes (blocked, enforced, acknowledged-unsandboxed)', () => {
    expect(
      SandboxGate.check({ validation: { sandboxEnforced: false, allowUnsandboxedAck: false } }, {})
    ).toEqual({ ok: false, code: 'sandbox-not-enforced' })

    expect(
      SandboxGate.check({ validation: { sandboxEnforced: true } }, {})
    ).toEqual({ ok: true, mode: 'enforced' })

    expect(
      SandboxGate.check(
        { validation: { sandboxEnforced: false, allowUnsandboxedAck: true } },
        { unsandboxedAck: { by: 'admin', at: new Date() } }
      )
    ).toEqual({ ok: true, mode: 'acknowledged-unsandboxed' })
  })

  it('nulls user references and cancels queued jobs on UserDeletion.onUserRemoved', async () => {
    const mockItemsCol = { updateMany: vi.fn(async () => ({ modifiedCount: 1 })) }
    const mockAuditCol = { updateMany: vi.fn(async () => ({ modifiedCount: 1 })) }
    const mockJobsCol = { updateMany: vi.fn(async () => ({ modifiedCount: 1 })) }
    setCollectionOverrideForTests({
      templateGalleryItems: mockItemsCol,
      templateGalleryAudit: mockAuditCol,
      templateGalleryJobs: mockJobsCol,
    })

    await UserDeletion.onUserRemoved('deleted-user-42')
    expect(mockItemsCol.updateMany).toHaveBeenCalled()
    expect(mockAuditCol.updateMany).toHaveBeenCalled()
    expect(mockJobsCol.updateMany).toHaveBeenCalled()
  })

  it('detects GitHub & GitLab repo URLs for Tier 2 and installs navigation idempotently', () => {
    const gh = detectGitRepoUrl('Source at https://github.com/latex-ninja/modern-simple-cv for details.')
    expect(gh).toMatchObject({
      host: 'github.com',
      owner: 'latex-ninja',
      repo: 'modern-simple-cv',
    })

    Settings.templateLinks = []
    Lifecycle.installNavigation(DEFAULTS)
    Lifecycle.installNavigation(DEFAULTS)
    expect(Settings.templateLinks.filter(l => l.url === '/latex/templates')).toHaveLength(1)
  })
})
