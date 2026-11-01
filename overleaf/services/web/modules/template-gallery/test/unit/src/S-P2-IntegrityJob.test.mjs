import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as IntegrityJob from '../../../app/src/jobs/handlers/IntegrityJob.mjs'
import BlobStore from '../../../app/src/storage/BlobStore.mjs'
import Paths from '../../../app/src/storage/Paths.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'

const MISSING_SHA = 'a'.repeat(64)

/**
 * Records every find filter and update. `scan` answers the regular pass,
 * `recovery` answers the blob_missing pass.
 */
function fakeItemsCol({ scan = [], recovery = [], matchedFor = () => 1 } = {}) {
  const finds = []
  const updates = []
  const col = {
    finds,
    updates,
    find(filter) {
      finds.push(filter)
      const docs = filter.state === 'blob_missing' ? recovery : scan
      const chain = {
        sort: () => chain,
        limit: () => chain,
        toArray: async () => docs,
      }
      return chain
    },
    updateOne: vi.fn(async (filter, update) => {
      updates.push({ filter, update })
      const matchedCount = matchedFor(filter)
      return { matchedCount, modifiedCount: matchedCount }
    }),
  }
  return col
}

function failingStream(code) {
  return new Readable({
    read() {
      const err = new Error(`${code}: simulated`)
      err.code = code
      this.destroy(err)
    },
  })
}

describe('S-P2 IntegrityJob transient errors and guarded repairs', () => {
  let tmpDir
  const cfg = () => ({ storageDir: tmpDir })

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 's-p2-integrity-')
    )
  })

  afterEach(async () => {
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  async function blobFor(text) {
    const res = await BlobStore.putBuffer(Buffer.from(text), {
      storageDir: tmpDir,
    })
    return res.sha256
  }

  async function tamper(sha) {
    await fs.promises.writeFile(Paths.blobPath(tmpDir, sha), 'tampered')
  }

  it('treats an unreadable blob (io_error) as transient: only the check timestamp moves', async () => {
    const sha = await blobFor('thumb-bytes')
    const col = fakeItemsCol({
      scan: [{ _id: 'i1', state: 'published', media: { thumbSha: sha } }],
    })
    setCollectionOverrideForTests({ templateGalleryItems: col })
    vi.spyOn(fs, 'createReadStream').mockImplementation(() =>
      failingStream('EIO')
    )

    const res = await IntegrityJob.run({}, { cfg: cfg() })

    expect(res.ioErrorCount).toBe(1)
    expect(res.corruptedCount).toBe(0)
    expect(col.updates).toHaveLength(1)
    const { filter, update } = col.updates[0]
    expect(filter).toEqual({ _id: 'i1' })
    expect(Object.keys(update.$set)).toEqual(['integrity.lastCheckedAt'])
    expect(update.$unset).toBeUndefined()
    expect(fs.existsSync(Paths.blobPath(tmpDir, sha))).toBe(true)
  })

  it('marks a healthy item as integrity ok', async () => {
    const sha = await blobFor('healthy-thumb')
    const col = fakeItemsCol({
      scan: [{ _id: 'i-ok', state: 'published', media: { thumbSha: sha } }],
    })
    setCollectionOverrideForTests({ templateGalleryItems: col })

    const res = await IntegrityJob.run({}, { cfg: cfg() })

    expect(res.verifiedCount).toBe(1)
    expect(col.updates[0].filter).toEqual({ _id: 'i-ok' })
    expect(col.updates[0].update.$set['integrity.status']).toBe('ok')
  })

  it('dereferences a missing re-fetchable blob with a guard on the sha it checked', async () => {
    const col = fakeItemsCol({
      scan: [
        {
          _id: 'i2',
          state: 'published',
          media: { thumbSha: MISSING_SHA, thumbMime: 'image/jpeg' },
          mirror: { thumbAt: new Date() },
        },
      ],
    })
    setCollectionOverrideForTests({ templateGalleryItems: col })

    const res = await IntegrityJob.run({}, { cfg: cfg() })

    expect(res.corruptedCount).toBe(1)
    const { filter, update } = col.updates[0]
    expect(filter).toEqual({ _id: 'i2', 'media.thumbSha': MISSING_SHA })
    expect(update.$unset).toEqual({
      'media.thumbSha': '',
      'media.thumbMime': '',
      'mirror.thumbAt': '',
    })
    expect(update.$set['integrity.status']).toBe('corrupted')
    expect(update.$set.state).toBeUndefined()
  })

  it('quarantines a corrupt media blob and dereferences it', async () => {
    const sha = await blobFor('media-bytes')
    await tamper(sha)
    const col = fakeItemsCol({
      scan: [{ _id: 'i3', state: 'published', media: { thumbSha: sha } }],
    })
    setCollectionOverrideForTests({ templateGalleryItems: col })

    const res = await IntegrityJob.run({}, { cfg: cfg() })

    expect(res.corruptedCount).toBe(1)
    expect(col.updates[0].filter).toEqual({ _id: 'i3', 'media.thumbSha': sha })
    expect(col.updates[0].update.$unset).toHaveProperty('media.thumbSha', '')
    expect(fs.existsSync(Paths.blobPath(tmpDir, sha))).toBe(false)
    expect(
      await fs.promises.readdir(path.join(tmpDir, 'quarantine'))
    ).toHaveLength(1)
  })

  it('drops the whole source record when the source package is corrupt', async () => {
    const sha = await blobFor('zip-bytes')
    await tamper(sha)
    const col = fakeItemsCol({
      scan: [
        {
          _id: 'i4',
          state: 'published',
          sourceAcquired: true,
          sourceBlobStoreKey: sha,
          acquisitionTier: 1,
          zip: { sha256: sha },
        },
      ],
    })
    setCollectionOverrideForTests({ templateGalleryItems: col })

    const res = await IntegrityJob.run({}, { cfg: cfg() })

    expect(res.corruptedCount).toBe(1)
    const { filter, update } = col.updates[0]
    expect(filter).toEqual({
      _id: 'i4',
      sourceBlobStoreKey: sha,
      'zip.sha256': sha,
    })
    expect(update.$unset).toEqual({
      sourceBlobStoreKey: '',
      sourcePackageHash: '',
      acquisitionTier: '',
      sourceAcquired: '',
      'zip.sha256': '',
    })
  })

  it('retries an item on a later run when its guarded update matches nothing', async () => {
    const col = fakeItemsCol({
      scan: [
        {
          _id: 'i7',
          state: 'published',
          media: { thumbSha: MISSING_SHA },
        },
      ],
      matchedFor: filter => (Object.keys(filter).length > 1 ? 0 : 1),
    })
    setCollectionOverrideForTests({ templateGalleryItems: col })

    await IntegrityJob.run({}, { cfg: cfg() })

    const upds = col.updates.filter(u => u.filter._id === 'i7')
    expect(upds).toHaveLength(2)
    expect(upds[0].filter).toEqual({ _id: 'i7', 'media.thumbSha': MISSING_SHA })
    expect(upds[1].filter).toEqual({ _id: 'i7' })
    expect(Object.keys(upds[1].update.$set)).toEqual([
      'integrity.lastCheckedAt',
    ])
  })
})
