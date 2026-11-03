import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import BlobStore from '../../../app/src/storage/BlobStore.mjs'
import Paths from '../../../app/src/storage/Paths.mjs'
import * as DedupCollector from '../../../app/src/storage/DedupCollector.mjs'
import { setCollectionOverrideForTests } from '../../../app/src/persistence/Collections.mjs'
import { FakeCollection } from './support/FakeCollection.mjs'

const HOUR = 3600_000
const DAY = 24 * HOUR
const sha = text => crypto.createHash('sha256').update(text).digest('hex')

// A PDF with volatile metadata; the same body gives the same normalized hash
function fakePdf({ created = 'D:20240101000000Z', id = 'a1b2', body = 'BT (Hello) Tj ET' } = {}) {
  return Buffer.from(
    [
      '%PDF-1.4',
      `1 0 obj << /Title (T) /CreationDate (${created}) /ModDate (${created}) >> endobj`,
      `2 0 obj << /Length ${body.length} >> stream`,
      body,
      'endstream endobj',
      `trailer << /ID [<${id}> <${id}>] /Root 1 0 R >>`,
      '%%EOF',
      '',
    ].join('\n'),
    'latin1'
  )
}

async function ageFile(file, ageMs) {
  const when = new Date(Date.now() - ageMs)
  await fs.promises.utimes(file, when, when)
}

async function putAged(storageDir, buffer) {
  const { sha256 } = await BlobStore.putBuffer(buffer, { storageDir })
  await ageFile(Paths.blobPath(storageDir, sha256), 2 * DAY)
  return sha256
}

const blobExists = (storageDir, shaValue) => fs.existsSync(Paths.blobPath(storageDir, shaValue))

function setup(storageDir, { snapshot = new Set(), snapshotThrows = false } = {}) {
  const shared = {
    items: new FakeCollection([]),
    config: new FakeCollection([]),
    listings: new FakeCollection([]),
  }
  setCollectionOverrideForTests({
    templateGalleryItems: shared.items,
    templateGalleryConfig: shared.config,
    templateGalleryListings: shared.listings,
  })
  const exportSnapshot = vi.fn(async () => ({ generation: 'gen-test' }))
  const snapshotRefs = vi.fn(async () => {
    if (snapshotThrows) throw new Error('snapshot unreadable')
    return snapshot
  })
  DedupCollector.setDependenciesForTests({
    lock: { acquire: async () => true, release: async () => {} },
    exportSnapshot,
    snapshotRefs,
  })
  return { ...shared, exportSnapshot, snapshotRefs, storageDir }
}

describe('S-P7 DedupCollector', () => {
  let dir
  let fixtures

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 's-p7-dedup-'))
  })

  afterEach(async () => {
    setCollectionOverrideForTests(null)
    DedupCollector.setDependenciesForTests(null)
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  // A and D share the exact PDF, B has the same content with other dates (same normalized PDF),
  // C is unrelated, E is a live item that still uses one image of D.
  async function buildFixtures() {
    const pdfA = await putAged(dir, fakePdf({ created: 'D:20240101000000Z', id: 'a1' }))
    const pdfB = await putAged(dir, fakePdf({ created: 'D:20250505000000Z', id: 'b2' }))
    const pdfC = await putAged(dir, fakePdf({ body: 'BT (Different) Tj ET' }))
    const pdfE = await putAged(dir, fakePdf({ body: 'BT (Eee) Tj ET' }))
    const imgI = await putAged(dir, Buffer.from('image-shared'))
    const imgD = await putAged(dir, Buffer.from('image-d-only'))
    const imgC = await putAged(dir, Buffer.from('image-c'))
    const srcA = await putAged(dir, Buffer.from('source-a'))
    const srcC = await putAged(dir, Buffer.from('source-c'))
    const base = { state: 'published', mirror: { removedAt: null }, duplicateOf: null, family: 'templates', slug: 'x' }
    fixtures = { pdfA, pdfB, pdfC, pdfE, imgI, imgD, imgC, srcA, srcC }
    return [
      {
        _id: '1', token: 'aaaaaaaaaaaa', ...base, title: 'Thesis Template', createdAt: '2020-01-01T00:00:00Z',
        featured: false, sourceAcquired: true, tags: [{ name: 'cv' }], stats: { opens: 10 },
        media: { pdfSha: pdfA, thumbSha: imgI, previewSha: imgI, pdfBytes: 1 },
        sourceBlobStoreKey: srcA, zip: { sha256: srcA },
      },
      {
        _id: '2', token: 'bbbbbbbbbbbb', ...base, title: 'Thesis Template', createdAt: '2024-01-01T00:00:00Z',
        tags: [], stats: { opens: 0 },
        media: { pdfSha: pdfB, thumbSha: imgI, previewSha: imgI, pdfBytes: 1 },
      },
      {
        _id: '3', token: 'cccccccccccc', ...base, title: 'Unrelated', createdAt: '2021-01-01T00:00:00Z',
        tags: [], stats: { opens: 0 },
        media: { pdfSha: pdfC, thumbSha: imgC, previewSha: imgC },
        sourceBlobStoreKey: srcC, zip: { sha256: srcC },
      },
      {
        _id: '4', token: 'dddddddddddd', ...base, title: 'Thesis Template', createdAt: '2022-01-01T00:00:00Z',
        tags: [], stats: { opens: 0 },
        media: { pdfSha: pdfA, thumbSha: imgD, previewSha: imgD, pdfBytes: 1 },
        pdfBlobStoreKey: pdfA,
      },
      {
        _id: '5', token: 'eeeeeeeeeeee', ...base, title: 'Other live item', createdAt: '2023-01-01T00:00:00Z',
        tags: [], stats: { opens: 0 },
        media: { pdfSha: pdfE, thumbSha: imgD, previewSha: imgD },
      },
    ]
  }

  it('dry run plans the duplicates and changes no item and no file', async () => {
    const docs = await buildFixtures()
    const env = setup(dir)
    env.items.docs = docs

    const report = await DedupCollector.runDedup({ storageDir: dir, dryRun: true, yieldMs: 0 })

    expect(report.dryRun).toBe(true)
    expect(report.skipped).toBeNull()
    expect(report.duplicates.groups).toBe(1)
    expect(report.duplicates.duplicates).toBe(2)
    expect(report.duplicates.planned).toBe(2)
    expect(report.duplicates.applied).toBe(0)
    expect(env.items.peek(doc => doc.token === 'bbbbbbbbbbbb').duplicateOf).toBeNull()
    expect(env.items.peek(doc => doc.token === 'dddddddddddd').duplicateOf).toBeNull()
    expect(env.exportSnapshot).not.toHaveBeenCalled()
    expect(blobExists(dir, fixtures.pdfB)).toBe(true)
    expect(report.reclaimable.files).toBeGreaterThan(0)
    // fingerprints are cached on the item (the only write a dry run makes)
    expect(env.items.peek(doc => doc.token === 'bbbbbbbbbbbb').dedup.status).toBe('ok')
  })

  it('apply tombstones the duplicates, keeps their docs and unsets only the refs the canonical lacks', async () => {
    const docs = await buildFixtures()
    const env = setup(dir)
    env.items.docs = docs

    const report = await DedupCollector.runDedup({ storageDir: dir, dryRun: false, yieldMs: 0 })

    expect(report.duplicates.applied).toBe(2)
    const canonical = env.items.peek(doc => doc.token === 'aaaaaaaaaaaa')
    const b = env.items.peek(doc => doc.token === 'bbbbbbbbbbbb')
    const d = env.items.peek(doc => doc.token === 'dddddddddddd')
    expect(b.duplicateOf).toBe('aaaaaaaaaaaa')
    expect(b.duplicateAt).toBeInstanceOf(Date)
    expect(d.duplicateOf).toBe('aaaaaaaaaaaa')
    expect(canonical.dedup.duplicates.sort()).toEqual(['bbbbbbbbbbbb', 'dddddddddddd'])
    // B: its own PDF and the image of the canonical is shared, so only the PDF goes
    expect(b.media.pdfSha).toBeUndefined()
    expect(b.media.thumbSha).toBe(fixtures.imgI)
    // D: the PDF is the canonical's, its own image is not
    expect(d.media.pdfSha).toBe(fixtures.pdfA)
    expect(d.media.thumbSha).toBeUndefined()
    expect(d.pdfBlobStoreKey).toBe(fixtures.pdfA)
    // the canonical keeps everything, and gets the tags it lacked (none here)
    expect(canonical.media.pdfSha).toBe(fixtures.pdfA)
    expect(canonical.sourceBlobStoreKey).toBe(fixtures.srcA)
    expect(env.exportSnapshot).toHaveBeenCalledWith('dedup')
    // no purge: the files stay until the regular GC sweeps them after the grace period
    expect(blobExists(dir, fixtures.pdfB)).toBe(true)
    expect(report.reclaimable.files).toBeGreaterThan(0)
  })

  it('purge deletes the unset blobs that nothing uses, and keeps blobs still referenced', async () => {
    const docs = await buildFixtures()
    const env = setup(dir)
    env.items.docs = docs

    const report = await DedupCollector.runDedup({ storageDir: dir, dryRun: false, purge: true, yieldMs: 0 })

    // pdfB was only the duplicate's PDF: gone
    expect(blobExists(dir, fixtures.pdfB)).toBe(false)
    // imgD was the duplicate's image but live item E still uses it: kept
    expect(blobExists(dir, fixtures.imgD)).toBe(true)
    expect(report.purged.deleted).toBe(1)
    expect(report.purged.stillReferenced).toBe(1)
    expect(report.purged.bytes).toBeGreaterThan(0)
    // the canonical's blobs are untouched
    expect(blobExists(dir, fixtures.pdfA)).toBe(true)
    expect(blobExists(dir, fixtures.imgI)).toBe(true)
    expect(report.freed.byCategory.blobPurge.files).toBe(1)
  })

  it('purge keeps a blob the current snapshot still references, and retries it on a later run', async () => {
    const docs = await buildFixtures()
    const env = setup(dir, { snapshot: new Set([fixtures.pdfB]) })
    env.items.docs = docs

    const first = await DedupCollector.runDedup({ storageDir: dir, dryRun: false, purge: true, yieldMs: 0 })
    expect(blobExists(dir, fixtures.pdfB)).toBe(true)
    expect(first.purged.keptForSnapshot).toBe(1)
    expect(first.purged.pending).toBe(1)

    // the next export no longer references it
    env.snapshotRefs.mockImplementation(async () => new Set())
    const second = await DedupCollector.runDedup({ storageDir: dir, dryRun: false, purge: true, yieldMs: 0 })
    expect(blobExists(dir, fixtures.pdfB)).toBe(false)
    expect(second.purged.deleted).toBe(1)
    expect(second.purged.pending).toBe(0)
  })

  it('a clean run without purge queues the unset blobs, and a later purge run deletes them', async () => {
    const docs = await buildFixtures()
    const env = setup(dir)
    env.items.docs = docs

    const clean = await DedupCollector.runDedup({ storageDir: dir, dryRun: false, yieldMs: 0 })
    expect(clean.purged.deleted).toBe(0)
    expect(blobExists(dir, fixtures.pdfB)).toBe(true)
    expect((await DedupCollector.getStatus()).pendingPurge).toBeGreaterThan(0)

    const purge = await DedupCollector.runDedup({ storageDir: dir, dryRun: false, purge: true, yieldMs: 0 })
    expect(blobExists(dir, fixtures.pdfB)).toBe(false)
    expect(purge.purged.deleted).toBeGreaterThan(0)
    expect((await DedupCollector.getStatus()).pendingPurge).toBe(0)
  })

  it('the reclaimable estimate counts a blob that a retained generation still references as kept', async () => {
    const docs = await buildFixtures()
    const env = setup(dir, { snapshot: new Set([fixtures.pdfB]) })
    env.items.docs = docs

    const report = await DedupCollector.runDedup({ storageDir: dir, dryRun: true, yieldMs: 0 })
    // pdfB is still referenced by the retained snapshot: it is not reclaimable
    expect(report.reclaimable.files).toBe(0)
  })

  it('skips the purge when the snapshot refs cannot be read (fail safe)', async () => {
    const docs = await buildFixtures()
    const env = setup(dir, { snapshotThrows: true })
    env.items.docs = docs

    const report = await DedupCollector.runDedup({ storageDir: dir, dryRun: false, purge: true, yieldMs: 0 })

    expect(report.purged.skipped).toBe('snapshot_unavailable')
    expect(report.purged.deleted).toBe(0)
    expect(blobExists(dir, fixtures.pdfB)).toBe(true)
    // the tombstones themselves still happen (they delete nothing)
    expect(report.duplicates.applied).toBe(2)
  })

  it('does nothing and deletes nothing when the items collection is empty', async () => {
    await buildFixtures()
    const env = setup(dir)
    env.items.docs = []

    const report = await DedupCollector.runDedup({ storageDir: dir, dryRun: false, purge: true, yieldMs: 0 })

    expect(report.skipped).toBe('items_empty')
    expect(env.exportSnapshot).not.toHaveBeenCalled()
    expect(blobExists(dir, fixtures.pdfB)).toBe(true)
    expect(blobExists(dir, fixtures.pdfA)).toBe(true)
  })

  it('caches each fingerprint and only recomputes when the PDF changes', async () => {
    const docs = await buildFixtures()
    const env = setup(dir)
    env.items.docs = docs

    const first = await DedupCollector.runDedup({ storageDir: dir, dryRun: true, yieldMs: 0 })
    expect(first.fingerprints.computed).toBeGreaterThan(0)
    expect(first.fingerprints.cached).toBe(0)

    const second = await DedupCollector.runDedup({ storageDir: dir, dryRun: true, yieldMs: 0 })
    expect(second.fingerprints.computed).toBe(0)
    expect(second.fingerprints.cached).toBe(first.fingerprints.scanned)

    // a new PDF on one item: only that one is fingerprinted again
    const newPdf = await putAged(dir, fakePdf({ body: 'BT (New) Tj ET' }))
    env.items.peek(doc => doc.token === 'cccccccccccc').media.pdfSha = newPdf
    const third = await DedupCollector.runDedup({ storageDir: dir, dryRun: true, yieldMs: 0 })
    expect(third.fingerprints.computed).toBe(1)
    expect(env.items.peek(doc => doc.token === 'cccccccccccc').dedup.pdfSha).toBe(newPdf)
  })

  it('restores a tombstoned duplicate and marks it kept', async () => {
    const docs = await buildFixtures()
    const env = setup(dir)
    env.items.docs = docs
    await DedupCollector.runDedup({ storageDir: dir, dryRun: false, yieldMs: 0 })

    const res = await DedupCollector.restoreDuplicate('bbbbbbbbbbbb')

    expect(res).toEqual({ restored: true, canonical: 'aaaaaaaaaaaa' })
    const b = env.items.peek(doc => doc.token === 'bbbbbbbbbbbb')
    expect(b.duplicateOf).toBeUndefined()
    expect(b.dedup.keep).toBe(true)
    expect(env.items.peek(doc => doc.token === 'aaaaaaaaaaaa').dedup.duplicates).toEqual(['dddddddddddd'])
    expect(await DedupCollector.restoreDuplicate('cccccccccccc')).toEqual({ restored: false, reason: 'not_a_duplicate' })
    expect(await DedupCollector.restoreDuplicate('nope')).toEqual({ restored: false, reason: 'invalid_token' })
  })

  it('lists tombstones and reports the status', async () => {
    const docs = await buildFixtures()
    const env = setup(dir)
    env.items.docs = docs
    await DedupCollector.runDedup({ storageDir: dir, dryRun: false, yieldMs: 0 })

    const rows = await DedupCollector.listTombstones()
    expect(rows.map(row => row.token).sort()).toEqual(['bbbbbbbbbbbb', 'dddddddddddd'])
    const status = await DedupCollector.getStatus()
    expect(status.tombstones).toBe(2)
    expect(status.report.duplicates.applied).toBe(2)
    expect(status.lastRunAt).toBeInstanceOf(Date)
  })
})
