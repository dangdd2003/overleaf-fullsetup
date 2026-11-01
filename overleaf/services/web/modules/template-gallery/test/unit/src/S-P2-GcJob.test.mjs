import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as GcJob from '../../../app/src/jobs/handlers/GcJob.mjs'
import BlobStore from '../../../app/src/storage/BlobStore.mjs'
import Paths from '../../../app/src/storage/Paths.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'

const HOUR = 3600_000
const DAY = 24 * HOUR

function cfgFor(storageDir) {
  return { storageDir, runner: { blobGraceMs: DAY, tmpMaxAgeMs: HOUR } }
}

function fakeCollections(items = []) {
  const configUpdates = []
  return {
    templateGalleryItems: {
      find: () => ({
        async *[Symbol.asyncIterator]() {
          for (const doc of items) yield doc
        },
      }),
      findOne: async () => (items.length > 0 ? items[0] : null),
    },
    templateGalleryConfig: {
      updateOne: vi.fn(async (...args) => {
        configUpdates.push(args)
        return {}
      }),
    },
    configUpdates,
  }
}

async function ageFile(filePath, ageMs) {
  const when = new Date(Date.now() - ageMs)
  await fs.promises.utimes(filePath, when, when)
}

async function putBlob(storageDir, text) {
  const res = await BlobStore.putBuffer(Buffer.from(text), { storageDir })
  return res.sha256
}

describe('S-P2 GcJob guards and retention', () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 's-p2-gc-'))
    GcJob.setSnapshotLoaderForTests(async () => ({
      snapshotBlobRefs: async () => new Set(),
    }))
  })

  afterEach(async () => {
    GcJob.setSnapshotLoaderForTests(null)
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  it('never sweeps blobs when the Mongo items collection is empty', async () => {
    const orphan = await putBlob(tmpDir, 'orphan-when-mongo-is-empty')
    await ageFile(Paths.blobPath(tmpDir, orphan), 2 * DAY)
    setCollectionOverrideForTests(fakeCollections([]))

    const res = await GcJob.run({}, { cfg: cfgFor(tmpDir) })

    expect(fs.existsSync(Paths.blobPath(tmpDir, orphan))).toBe(true)
    expect(res.blobsSwept).toBe(0)
    expect(res.blobSweepSkipped).toBe('items_empty')
  })

  it('sweeps only unreferenced blobs older than the grace period', async () => {
    const referenced = await putBlob(tmpDir, 'referenced-thumb')
    const orphanOld = await putBlob(tmpDir, 'orphan-old')
    const orphanYoung = await putBlob(tmpDir, 'orphan-young')
    await ageFile(Paths.blobPath(tmpDir, referenced), 2 * DAY)
    await ageFile(Paths.blobPath(tmpDir, orphanOld), 2 * DAY)
    setCollectionOverrideForTests(
      fakeCollections([{ _id: 'i1', media: { thumbSha: referenced } }])
    )

    const res = await GcJob.run({}, { cfg: cfgFor(tmpDir) })

    expect(fs.existsSync(Paths.blobPath(tmpDir, referenced))).toBe(true)
    expect(fs.existsSync(Paths.blobPath(tmpDir, orphanOld))).toBe(false)
    expect(fs.existsSync(Paths.blobPath(tmpDir, orphanYoung))).toBe(true)
    expect(res.blobsSwept).toBe(1)
    expect(res.blobSweepSkipped).toBe(null)
  })

  it('keeps blobs referenced only by the volume snapshot (union with Mongo refs)', async () => {
    const snapOnly = await putBlob(tmpDir, 'known-only-to-snapshot')
    const orphan = await putBlob(tmpDir, 'truly-orphan')
    await ageFile(Paths.blobPath(tmpDir, snapOnly), 2 * DAY)
    await ageFile(Paths.blobPath(tmpDir, orphan), 2 * DAY)
    GcJob.setSnapshotLoaderForTests(async () => ({
      snapshotBlobRefs: async () => new Set([snapOnly]),
    }))
    setCollectionOverrideForTests(
      fakeCollections([{ _id: 'i1', sourceBlobStoreKey: 'b'.repeat(64) }])
    )

    const res = await GcJob.run({}, { cfg: cfgFor(tmpDir) })

    expect(fs.existsSync(Paths.blobPath(tmpDir, snapOnly))).toBe(true)
    expect(fs.existsSync(Paths.blobPath(tmpDir, orphan))).toBe(false)
    expect(res.blobsSwept).toBe(1)
  })

  it('skips the blob sweep when the snapshot module is missing, but still cleans tmp, scratch and quarantine', async () => {
    const orphan = await putBlob(tmpDir, 'orphan-missing-snapshot')
    await ageFile(Paths.blobPath(tmpDir, orphan), 2 * DAY)

    const tmpFile = path.join(tmpDir, 'tmp', 'stale.upload')
    const scratchFile = path.join(tmpDir, 'scratch', 'stale.zip')
    await fs.promises.mkdir(path.dirname(tmpFile), { recursive: true })
    await fs.promises.mkdir(path.dirname(scratchFile), { recursive: true })
    await fs.promises.writeFile(tmpFile, 'x')
    await fs.promises.writeFile(scratchFile, 'x')
    await ageFile(tmpFile, 2 * HOUR)
    await ageFile(scratchFile, 2 * HOUR)

    const quarantineDir = path.join(tmpDir, 'quarantine')
    await fs.promises.mkdir(quarantineDir, { recursive: true })
    const shaOld = 'c'.repeat(64)
    const shaNew = 'd'.repeat(64)
    const oldEntry = path.join(
      quarantineDir,
      `${shaOld}-${Date.now() - 31 * DAY}`
    )
    const newEntry = path.join(quarantineDir, `${shaNew}-${Date.now() - DAY}`)
    await fs.promises.writeFile(oldEntry, 'q')
    await fs.promises.writeFile(newEntry, 'q')

    GcJob.setSnapshotLoaderForTests(async () => {
      throw new Error("Cannot find module '../../storage/CatalogSnapshot.mjs'")
    })
    setCollectionOverrideForTests(
      fakeCollections([{ _id: 'i1', media: { thumbSha: 'e'.repeat(64) } }])
    )

    const res = await GcJob.run({}, { cfg: cfgFor(tmpDir) })

    expect(res.blobSweepSkipped).toBe('snapshot_unavailable')
    expect(fs.existsSync(Paths.blobPath(tmpDir, orphan))).toBe(true)
    expect(fs.existsSync(tmpFile)).toBe(false)
    expect(fs.existsSync(scratchFile)).toBe(false)
    expect(fs.existsSync(oldEntry)).toBe(false)
    expect(fs.existsSync(newEntry)).toBe(true)
    expect(res.tmpCleaned).toBe(1)
    expect(res.scratchCleaned).toBe(1)
    expect(res.quarantineCleaned).toBe(1)
  })

  it('skips the blob sweep when snapshotBlobRefs throws', async () => {
    const orphan = await putBlob(tmpDir, 'orphan-snapshot-throws')
    await ageFile(Paths.blobPath(tmpDir, orphan), 2 * DAY)
    GcJob.setSnapshotLoaderForTests(async () => ({
      snapshotBlobRefs: async () => {
        throw new Error('snapshot manifest is corrupt')
      },
    }))
    setCollectionOverrideForTests(
      fakeCollections([{ _id: 'i1', media: { thumbSha: 'f'.repeat(64) } }])
    )

    const res = await GcJob.run({}, { cfg: cfgFor(tmpDir) })

    expect(res.blobSweepSkipped).toBe('snapshot_unavailable')
    expect(fs.existsSync(Paths.blobPath(tmpDir, orphan))).toBe(true)
  })

  it('skips the blob sweep when the snapshot module has no snapshotBlobRefs export', async () => {
    const orphan = await putBlob(tmpDir, 'orphan-no-export')
    await ageFile(Paths.blobPath(tmpDir, orphan), 2 * DAY)
    GcJob.setSnapshotLoaderForTests(async () => ({}))
    setCollectionOverrideForTests(
      fakeCollections([{ _id: 'i1', media: { thumbSha: '1'.repeat(64) } }])
    )

    const res = await GcJob.run({}, { cfg: cfgFor(tmpDir) })

    expect(res.blobSweepSkipped).toBe('snapshot_unavailable')
    expect(fs.existsSync(Paths.blobPath(tmpDir, orphan))).toBe(true)
  })

  it('re-stats a candidate right before unlink and keeps it when it was rewritten meanwhile', async () => {
    const orphan = await putBlob(tmpDir, 'orphan-rewritten')
    const orphanPath = Paths.blobPath(tmpDir, orphan)
    await ageFile(orphanPath, 2 * DAY)
    setCollectionOverrideForTests(
      fakeCollections([{ _id: 'i1', media: { thumbSha: '2'.repeat(64) } }])
    )

    const realStat = fs.promises.stat
    let statCallsForOrphan = 0
    vi.spyOn(fs.promises, 'stat').mockImplementation(
      async (filePath, options) => {
        const stats = await realStat(filePath, options)
        if (path.resolve(String(filePath)) === path.resolve(orphanPath)) {
          statCallsForOrphan++
          if (statCallsForOrphan >= 2) {
            // Rewritten after the listing: young again
            return { ...stats, mtimeMs: Date.now() }
          }
        }
        return stats
      }
    )

    const res = await GcJob.run({}, { cfg: cfgFor(tmpDir) })

    expect(statCallsForOrphan).toBeGreaterThanOrEqual(2)
    expect(fs.existsSync(orphanPath)).toBe(true)
    expect(res.blobsSwept).toBe(0)
  })

  it('records usage including the skip reason in the config collection', async () => {
    const cols = fakeCollections([])
    setCollectionOverrideForTests(cols)

    await GcJob.run({}, { cfg: cfgFor(tmpDir) })

    expect(cols.templateGalleryConfig.updateOne).toHaveBeenCalledTimes(1)
    const [filter, update, options] =
      cols.templateGalleryConfig.updateOne.mock.calls[0]
    expect(filter).toEqual({ _id: 'usage' })
    expect(update.$set.blobSweepSkipped).toBe('items_empty')
    expect(options).toEqual({ upsert: true })
  })
})
