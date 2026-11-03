import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as StorageController from '../../../app/src/controllers/StorageController.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import { FakeCollection } from './support/FakeCollection.mjs'

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = code => {
    res.statusCode = code
    return res
  }
  res.json = body => {
    res.body = body
    return res
  }
  return res
}

describe('S-P7 StorageController', () => {
  let jobs
  let config

  beforeEach(() => {
    jobs = new FakeCollection([])
    config = new FakeCollection([])
    setCollectionOverrideForTests({
      templateGalleryJobs: jobs,
      templateGalleryConfig: config,
      templateGalleryItems: new FakeCollection([]),
      templateGalleryListings: new FakeCollection([]),
    })
  })

  afterEach(() => {
    setCollectionOverrideForTests(null)
  })

  it('runs a preview (dry run) by default, and enqueues it as a dedup job', async () => {
    const res = fakeRes()
    await StorageController.runDedup({ body: {}, session: { user: { _id: 'admin-1' } } }, res)

    expect(res.statusCode).toBe(202)
    expect(res.body).toMatchObject({ queued: true, deduped: false, dryRun: true, purge: false })
    const [job] = jobs.docs
    expect(job).toMatchObject({ kind: 'dedup', requestedBy: 'admin-1', payload: { dryRun: true, purge: false } })
  })

  it('a clean run with purge enqueues a purge, a clean run without it does not', async () => {
    const withPurge = fakeRes()
    await StorageController.runDedup({ body: { dryRun: false, purge: true } }, withPurge)
    expect(withPurge.body).toMatchObject({ dryRun: false, purge: true })

    // purge is ignored for a preview
    const preview = fakeRes()
    await StorageController.runDedup({ body: { dryRun: true, purge: true } }, preview)
    expect(preview.body).toMatchObject({ dryRun: true, purge: false })

    const plain = fakeRes()
    await StorageController.runDedup({ body: { dryRun: false } }, plain)
    expect(plain.body).toMatchObject({ dryRun: false, purge: false })
    expect(jobs.docs.map(job => job.payload)).toEqual([
      { dryRun: false, purge: true },
      { dryRun: true, purge: false },
      { dryRun: false, purge: false },
    ])
  })

  it('rejects options that are not booleans', async () => {
    const res = fakeRes()
    await StorageController.runDedup({ body: { dryRun: 'no' } }, res)
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_option' })
    expect(jobs.docs).toHaveLength(0)
  })

  it('restores a duplicate by token and refuses invalid or unknown tokens', async () => {
    const items = new FakeCollection([
      { _id: '1', token: 'aaaaaaaaaaaa', state: 'published', duplicateOf: null, dedup: { duplicates: ['bbbbbbbbbbbb'] } },
      { _id: '2', token: 'bbbbbbbbbbbb', state: 'published', duplicateOf: 'aaaaaaaaaaaa', duplicateAt: new Date() },
    ])
    setCollectionOverrideForTests({
      templateGalleryJobs: jobs,
      templateGalleryConfig: config,
      templateGalleryItems: items,
      templateGalleryListings: new FakeCollection([]),
    })

    const bad = fakeRes()
    await StorageController.restoreDuplicate({ params: { token: 'nope' } }, bad)
    expect(bad.statusCode).toBe(400)

    const missing = fakeRes()
    await StorageController.restoreDuplicate({ params: { token: 'aaaaaaaaaaaa' } }, missing)
    expect(missing.statusCode).toBe(404)

    const ok = fakeRes()
    await StorageController.restoreDuplicate({ params: { token: 'bbbbbbbbbbbb' } }, ok)
    expect(ok.statusCode).toBe(200)
    expect(ok.body).toEqual({ restored: true, token: 'bbbbbbbbbbbb', canonical: 'aaaaaaaaaaaa' })
    expect(items.docs[1].duplicateOf).toBeUndefined()
    expect(items.docs[0].dedup.duplicates).toEqual([])
  })
})
