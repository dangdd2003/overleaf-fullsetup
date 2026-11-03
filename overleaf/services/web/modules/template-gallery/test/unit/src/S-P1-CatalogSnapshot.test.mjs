import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BSON, Binary, Decimal128, Long, ObjectId } from 'mongodb'
import {
  setCollectionOverrideForTests,
  SNAPSHOT_COLLECTIONS,
} from '../../../app/src/persistence/Collections.mjs'
import * as CatalogSnapshot from '../../../app/src/storage/CatalogSnapshot.mjs'

const ITEMS = 'templateGalleryItems'

const ITEM_A = {
  _id: new ObjectId('65a1b2c3d4e5f60718293a4b'),
  title: 'Résumé "quoted"\nline',
  objectID: '123',
  createdAt: new Date('2024-01-02T03:04:05.678Z'),
  updatedAt: new Date('2025-06-07T08:09:10.111Z'),
  count: 42,
  ratio: 0.5,
  big: Long.fromString('9007199254740993'),
  price: Decimal128.fromString('12.34'),
  thumb: new Binary(Buffer.from([1, 2, 3, 4])),
  nested: {
    list: [
      { when: new Date(0), ref: new ObjectId('65a1b2c3d4e5f60718293a4c') },
      null,
    ],
    empty: {},
  },
  media: { thumbSha: 'a'.repeat(64) },
  tags: [{ name: 'math' }],
}

const ITEM_B = {
  _id: new ObjectId('65a1b2c3d4e5f60718293a4d'),
  title: 'Second',
  pdfBlobStoreKey: 'b'.repeat(64),
  createdAt: new Date('2023-03-04T05:06:07.000Z'),
}

/**
 * In-memory stand-in for a Mongo collection. insertMany(ordered:false) reports duplicate _id
 * values as E11000 write errors, like the driver does.
 *
 * @param {any[]} [docs]
 */
function makeFakeCollection(docs = []) {
  const store = new Map()
  for (const doc of docs) store.set(String(doc._id), doc)
  return {
    store,
    find: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        for (const doc of [...store.values()]) yield doc
      },
    })),
    insertMany: vi.fn(async (batch, _opts) => {
      const writeErrors = []
      let insertedCount = 0
      batch.forEach((doc, index) => {
        const key = String(doc._id)
        if (store.has(key)) {
          writeErrors.push({
            index,
            code: 11000,
            errmsg: `E11000 duplicate key error collection: index: _id_ dup key: ${key}`,
          })
        } else {
          store.set(key, doc)
          insertedCount++
        }
      })
      if (writeErrors.length > 0) {
        throw Object.assign(
          new Error('E11000 duplicate key error collection'),
          {
            writeErrors,
            result: { insertedCount },
          }
        )
      }
      return { insertedCount }
    }),
    findOne: vi.fn(async () => store.values().next().value ?? null),
  }
}

/**
 * @param {Record<string, any>} [overrides]
 */
function installCollections(overrides = {}) {
  const cols = {}
  for (const name of SNAPSHOT_COLLECTIONS) {
    cols[name] = overrides[name] ?? makeFakeCollection()
  }
  cols.templateGalleryConfig =
    overrides.templateGalleryConfig ?? makeFakeCollection()
  setCollectionOverrideForTests(cols)
  return cols
}

/**
 * Resolves to the error a promise rejects with. Fails when it resolves.
 *
 * @param {Promise<unknown>} promise
 * @returns {Promise<any>}
 */
async function rejectionOf(promise) {
  const outcome = await promise.then(
    () => null,
    (err) => err
  )
  expect(outcome, 'expected the promise to reject').toBeInstanceOf(Error)
  return outcome
}

/** @param {any} doc */
const canonical = (doc) => BSON.EJSON.stringify(doc, { relaxed: false })

describe('CatalogSnapshot', () => {
  let dir

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-snapshot-'))
  })

  afterEach(async () => {
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  async function listGenerationDirs() {
    const names = await fs.promises.readdir(path.join(dir, 'catalog'))
    return names.filter((name) => name.startsWith('gen-')).sort()
  }

  describe('store identity', () => {
    it('creates store.json once and keeps it on later calls', async () => {
      const first = await CatalogSnapshot.ensureStoreIdentity(dir)
      const raw = await fs.promises.readFile(
        path.join(dir, 'store.json'),
        'utf8'
      )
      const second = await CatalogSnapshot.ensureStoreIdentity(dir)

      expect(second).toEqual(first)
      expect(first.storeId).toMatch(/^[0-9a-f-]{36}$/)
      expect(
        await fs.promises.readFile(path.join(dir, 'store.json'), 'utf8')
      ).toBe(raw)
      expect(JSON.parse(raw)).toMatchObject({
        format: 1,
        storeId: first.storeId,
        createdAt: first.createdAt,
      })
    })

    it('refuses to overwrite an unreadable store identity', async () => {
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(path.join(dir, 'store.json'), '{not json')

      await rejectionOf(CatalogSnapshot.ensureStoreIdentity(dir))
      expect(
        await fs.promises.readFile(path.join(dir, 'store.json'), 'utf8')
      ).toBe('{not json')
    })
  })

  describe('export and import', () => {
    it('writes a manifest whose counts, sizes and checksums match the files', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]) })

      const manifest = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
        reason: 'test',
      })

      expect(manifest).toMatchObject({ format: 1, reason: 'test' })
      expect(Object.keys(manifest.collections).sort()).toEqual(
        [...SNAPSHOT_COLLECTIONS].sort()
      )
      const genDir = path.join(dir, 'catalog', `gen-${manifest.generation}`)
      for (const [name, info] of Object.entries(manifest.collections)) {
        expect(info.file).toBe(`${name}.jsonl.gz`)
        const bytes = await fs.promises.readFile(path.join(genDir, info.file))
        expect(bytes.length).toBe(info.bytes)
        expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(
          info.sha256
        )
      }
      expect(manifest.collections[ITEMS].count).toBe(2)
      const pointer = JSON.parse(
        await fs.promises.readFile(
          path.join(dir, 'catalog', 'current.json'),
          'utf8'
        )
      )
      expect(pointer).toEqual({
        format: 1,
        generation: manifest.generation,
        dir: `gen-${manifest.generation}`,
      })
    })

    it('round-trips Date, ObjectId, Long, Decimal128, Binary and nested values unchanged', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })

      const target = installCollections()
      const result = await CatalogSnapshot.importSnapshot({ storageDir: dir })

      expect(result.counts[ITEMS]).toBe(2)
      const imported = [...target[ITEMS].store.values()]
      expect(imported.map((doc) => canonical(doc))).toEqual([
        canonical(ITEM_A),
        canonical(ITEM_B),
      ])

      const [a] = imported
      expect(a._id).toBeInstanceOf(ObjectId)
      expect(a._id.equals(ITEM_A._id)).toBe(true)
      expect(a.createdAt).toBeInstanceOf(Date)
      expect(a.createdAt.getTime()).toBe(ITEM_A.createdAt.getTime())
      expect(Long.isLong(a.big)).toBe(true)
      expect(a.big.toString()).toBe('9007199254740993')
      expect(a.price).toBeInstanceOf(Decimal128)
      expect(a.price.toString()).toBe('12.34')
      expect(a.thumb).toBeInstanceOf(Binary)
      expect(Buffer.from(a.thumb.buffer.subarray(0, a.thumb.position))).toEqual(
        Buffer.from([1, 2, 3, 4])
      )
      expect(a.nested.list[0].when).toBeInstanceOf(Date)
      expect(a.nested.list[0].ref).toBeInstanceOf(ObjectId)
      expect(a.title).toBe(ITEM_A.title)
    })

    it('imports in batches of 500 with ordered:false', async () => {
      const docs = Array.from({ length: 1234 }, (_, i) => ({
        _id: new ObjectId(),
        n: i,
        objectID: String(i),
      }))
      installCollections({ [ITEMS]: makeFakeCollection(docs) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })

      const target = installCollections()
      const result = await CatalogSnapshot.importSnapshot({ storageDir: dir })

      expect(result.counts[ITEMS]).toBe(1234)
      const calls = target[ITEMS].insertMany.mock.calls
      expect(calls.map((call) => call[0].length)).toEqual([500, 500, 234])
      for (const call of calls) {
        expect(call[1]).toEqual({ ordered: false })
      }
      expect(target[ITEMS].store.size).toBe(1234)
    })

    it('is duplicate-tolerant: re-importing over existing documents succeeds', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })

      const target = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A]),
      })
      const result = await CatalogSnapshot.importSnapshot({ storageDir: dir })

      expect(result.counts[ITEMS]).toBe(1)
      expect(target[ITEMS].store.size).toBe(2)
    })

    it('rethrows write errors that are not duplicate-key errors', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })

      const broken = makeFakeCollection()
      broken.insertMany.mockRejectedValueOnce(
        Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
      )
      installCollections({ [ITEMS]: broken })

      const err = await rejectionOf(
        CatalogSnapshot.importSnapshot({ storageDir: dir })
      )
      expect(err.message).toBe('connection reset')
    })

    it('rejects a corrupt collection file before inserting anything', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]) })
      const manifest = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
      })
      const itemsFile = path.join(
        dir,
        'catalog',
        `gen-${manifest.generation}`,
        `${ITEMS}.jsonl.gz`
      )
      await fs.promises.writeFile(itemsFile, Buffer.from('not gzip at all'))

      const target = installCollections()
      const err = await rejectionOf(
        CatalogSnapshot.importSnapshot({ storageDir: dir })
      )
      expect(err.code).toBe('SNAPSHOT_CORRUPT')
      for (const name of SNAPSHOT_COLLECTIONS) {
        expect(target[name].insertMany).not.toHaveBeenCalled()
      }
    })

    it('rejects import when there is no snapshot', async () => {
      installCollections()
      const err = await rejectionOf(
        CatalogSnapshot.importSnapshot({ storageDir: dir })
      )
      expect(err.code).toBe('SNAPSHOT_MISSING')
    })
  })

  describe('atomic publish', () => {
    it('keeps the previous generation readable when the pointer swap fails', async () => {
      const cols = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A]),
      })
      const first = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
        reason: 'first',
      })
      cols[ITEMS].store.set(String(ITEM_B._id), ITEM_B)

      const realRename = fs.promises.rename
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (String(to).endsWith('current.json')) {
          throw Object.assign(
            new Error('simulated crash before pointer swap'),
            { code: 'EIO' }
          )
        }
        return realRename(from, to)
      })

      const err = await rejectionOf(
        CatalogSnapshot.exportSnapshot({ storageDir: dir, reason: 'second' })
      )
      expect(err.message).toBe('simulated crash before pointer swap')
      vi.restoreAllMocks()

      const current = await CatalogSnapshot.readCurrentManifest(dir)
      expect(current.generation).toBe(first.generation)
      expect(await listGenerationDirs()).toEqual([`gen-${first.generation}`])
      const leftovers = (
        await fs.promises.readdir(path.join(dir, 'catalog'))
      ).filter((name) => name.includes('.tmp-'))
      expect(leftovers).toEqual([])

      const target = installCollections()
      const imported = await CatalogSnapshot.importSnapshot({
        storageDir: dir,
      })
      expect(imported.generation).toBe(first.generation)
      expect(imported.counts[ITEMS]).toBe(1)
      expect(target[ITEMS].store.size).toBe(1)
    })

    it('ignores abandoned temp directories and sweeps stale ones on export', async () => {
      const catalog = path.join(dir, 'catalog')
      const stale = path.join(catalog, '.tmp-stale')
      const fresh = path.join(catalog, '.tmp-fresh')
      await fs.promises.mkdir(stale, { recursive: true })
      await fs.promises.mkdir(fresh, { recursive: true })
      await fs.promises.writeFile(
        path.join(stale, 'partial.jsonl.gz'),
        'partial'
      )
      const twoHoursAgo = (Date.now() - 2 * 60 * 60_000) / 1000
      await fs.promises.utimes(stale, twoHoursAgo, twoHoursAgo)

      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      expect(await CatalogSnapshot.readCurrentManifest(dir)).toBeNull()
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })

      const names = await fs.promises.readdir(catalog)
      expect(names).not.toContain('.tmp-stale')
      expect(names).toContain('.tmp-fresh')
    })

    it('does not fail an export when the volume cannot fsync (ENOTSUP/EINVAL)', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      const realFsync = fs.fsync
      vi.spyOn(fs, 'fsync').mockImplementation((fd, callback) =>
        realFsync(fd, () =>
          callback(
            Object.assign(new Error('fsync not supported'), { code: 'EINVAL' })
          )
        )
      )

      const manifest = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
      })

      expect((await CatalogSnapshot.readCurrentManifest(dir)).generation).toBe(
        manifest.generation
      )
    })

    it('still fails an export on a real fsync I/O error', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      const realFsync = fs.fsync
      vi.spyOn(fs, 'fsync').mockImplementation((fd, callback) =>
        realFsync(fd, () =>
          callback(
            Object.assign(new Error('input/output error'), { code: 'EIO' })
          )
        )
      )

      const err = await rejectionOf(
        CatalogSnapshot.exportSnapshot({ storageDir: dir })
      )
      expect(err.code).toBe('EIO')
      expect(await CatalogSnapshot.readCurrentManifest(dir)).toBeNull()
    })

    it('treats an invalid pointer or a traversal generation as no snapshot', async () => {
      const catalog = path.join(dir, 'catalog')
      await fs.promises.mkdir(catalog, { recursive: true })

      await fs.promises.writeFile(
        path.join(catalog, 'current.json'),
        '{"format":1,'
      )
      expect(await CatalogSnapshot.readCurrentManifest(dir)).toBeNull()

      await fs.promises.writeFile(
        path.join(catalog, 'current.json'),
        JSON.stringify({
          format: 1,
          generation: '../../escape',
          dir: 'gen-../../escape',
        })
      )
      expect(await CatalogSnapshot.readCurrentManifest(dir)).toBeNull()
    })
  })

  describe('retention and guards', () => {
    it('keeps the current generation and one previous', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      const generations = []
      for (let i = 0; i < 5; i++) {
        const manifest = await CatalogSnapshot.exportSnapshot({
          storageDir: dir,
          reason: `run-${i}`,
        })
        generations.push(manifest.generation)
      }

      expect(await listGenerationDirs()).toEqual(
        generations
          .slice(-2)
          .map((generation) => `gen-${generation}`)
          .sort()
      )
      const current = await CatalogSnapshot.readCurrentManifest(dir)
      expect(current.generation).toBe(generations[4])
    }, 20_000)

    it('refuses to replace a snapshot that has items with an empty Items collection', async () => {
      const cols = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A]),
      })
      const first = await CatalogSnapshot.exportSnapshot({ storageDir: dir })
      cols[ITEMS].store.clear()

      const err = await rejectionOf(
        CatalogSnapshot.exportSnapshot({ storageDir: dir })
      )
      expect(err.code).toBe('SNAPSHOT_EMPTY_REFUSED')
      const current = await CatalogSnapshot.readCurrentManifest(dir)
      expect(current.generation).toBe(first.generation)
      expect(await listGenerationDirs()).toEqual([`gen-${first.generation}`])
    })

    it('refuses to shrink a snapshot below 50% of previous items without force or cli/manual reason', async () => {
      const tenItems = Array.from({ length: 10 }, (_, i) => ({
        _id: new ObjectId(),
        title: `Item ${i}`,
      }))
      const cols = installCollections({
        [ITEMS]: makeFakeCollection(tenItems),
      })
      const first = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
        reason: 'init',
      })

      // Shrink to 4 items (< 50% of 10)
      cols[ITEMS].store.clear()
      for (const item of tenItems.slice(0, 4)) {
        cols[ITEMS].store.set(String(item._id), item)
      }

      // Without force/cli: rejected
      const err = await rejectionOf(
        CatalogSnapshot.exportSnapshot({
          storageDir: dir,
          reason: 'automatic',
        })
      )
      expect(err.code).toBe('SNAPSHOT_SHRINK_REFUSED')
      expect((await CatalogSnapshot.readCurrentManifest(dir)).generation).toBe(
        first.generation
      )

      // With force: true: accepted
      const forced = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
        reason: 'automatic',
        force: true,
      })
      expect(forced.collections[ITEMS].count).toBe(4)

      // With reason 'cli': accepted
      cols[ITEMS].store.clear()
      cols[ITEMS].store.set(String(tenItems[0]._id), tenItems[0]) // 1 item
      const cliExp = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
        reason: 'cli',
      })
      expect(cliExp.collections[ITEMS].count).toBe(1)
    })

    it('aborts export without swapping pointer if checkLease fails', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      const first = await CatalogSnapshot.exportSnapshot({ storageDir: dir })

      const err = await rejectionOf(
        CatalogSnapshot.exportSnapshot({
          storageDir: dir,
          checkLease: async () => false,
        })
      )
      expect(err.code).toBe('SNAPSHOT_LEASE_LOST')
      expect((await CatalogSnapshot.readCurrentManifest(dir)).generation).toBe(
        first.generation
      )
    })
  })

  describe('iteration and blob references', () => {
    it('streams documents of one collection in export order', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })

      const ids = []
      for await (const doc of CatalogSnapshot.iterateSnapshotDocs(ITEMS, dir)) {
        ids.push(doc._id.toHexString())
      }
      expect(ids).toEqual([ITEM_A._id.toHexString(), ITEM_B._id.toHexString()])
    })

    it('rejects collection names that are not part of the snapshot', async () => {
      const iterate = async () => {
        for await (const doc of CatalogSnapshot.iterateSnapshotDocs(
          'templateGalleryJobs',
          dir
        )) {
          void doc
        }
      }
      const err = await rejectionOf(iterate())
      expect(err.code).toBe('SNAPSHOT_UNKNOWN_COLLECTION')
    })

    it('returns the blob shas referenced by snapshot items across all retained generations', async () => {
      const cols = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A]),
      })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir, reason: 'cli' })

      // Second generation with ITEM_B
      cols[ITEMS].store.clear()
      cols[ITEMS].store.set(String(ITEM_B._id), ITEM_B)
      await CatalogSnapshot.exportSnapshot({ storageDir: dir, reason: 'cli' })

      const shas = await CatalogSnapshot.snapshotBlobRefs(dir)
      // Both ITEM_A (thumbSha: 'a'*64) and ITEM_B (pdfBlobStoreKey: 'b'*64) are protected!
      expect([...shas].sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    })

    it('returns an empty set when there is no snapshot', async () => {
      expect(await CatalogSnapshot.snapshotBlobRefs(dir)).toEqual(new Set())
    })
  })
})
