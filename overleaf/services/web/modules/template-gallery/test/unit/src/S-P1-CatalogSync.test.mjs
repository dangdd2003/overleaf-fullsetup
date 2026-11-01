import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import Lock from '../../../app/src/jobs/Lock.mjs'
import {
  setCollectionOverrideForTests,
  SNAPSHOT_COLLECTIONS,
} from '../../../app/src/persistence/Collections.mjs'
import * as CatalogSnapshot from '../../../app/src/storage/CatalogSnapshot.mjs'
import * as CatalogSync from '../../../app/src/storage/CatalogSync.mjs'

// exportSnapshot is wrapped so the scheduling tests can replace it. The default is the real export.
vi.mock(
  '../../../app/src/storage/CatalogSnapshot.mjs',
  async (importOriginal) => {
    const actual = await importOriginal()
    return { ...actual, exportSnapshot: vi.fn(actual.exportSnapshot) }
  }
)

const realExport = (
  await vi.importActual('../../../app/src/storage/CatalogSnapshot.mjs')
).exportSnapshot

const ITEMS = 'templateGalleryItems'
const CONFIG = 'templateGalleryConfig'
const LEASE_OWNER = /^snapshot-\d+-[0-9a-f]{8}$/

const ITEM_A = {
  _id: new ObjectId('65a1b2c3d4e5f60718293a4b'),
  title: 'A',
  media: { thumbSha: 'a'.repeat(64) },
}
const ITEM_B = { _id: new ObjectId('65a1b2c3d4e5f60718293a4d'), title: 'B' }

/**
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
            errmsg: 'E11000 index: _id_ dup key',
          })
        } else {
          store.set(key, doc)
          insertedCount++
        }
      })
      if (writeErrors.length > 0) {
        throw Object.assign(new Error('E11000 duplicate key error'), {
          writeErrors,
          result: { insertedCount },
        })
      }
      return { insertedCount }
    }),
    findOne: vi.fn(async (filter = {}) =>
      filter._id != null
        ? (store.get(String(filter._id)) ?? null)
        : (store.values().next().value ?? null)
    ),
    updateOne: vi.fn(async (filter, update) => {
      const key = String(filter._id)
      store.set(key, { ...store.get(key), _id: filter._id, ...update.$set })
      return { matchedCount: 1 }
    }),
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
  cols[CONFIG] = overrides[CONFIG] ?? makeFakeCollection()
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

/** Lets pending promise callbacks run without advancing fake timers. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/**
 * @param {string} [generation]
 */
function fakeManifest(generation = 'g-1') {
  return {
    format: 1,
    storeId: 'store-1',
    generation,
    createdAt: new Date(0).toISOString(),
    reason: 'test',
    collections: Object.fromEntries(
      SNAPSHOT_COLLECTIONS.map((name) => [
        name,
        {
          file: `${name}.jsonl.gz`,
          count: name === ITEMS ? 2 : 0,
          bytes: 0,
          sha256: '0'.repeat(64),
        },
      ])
    ),
  }
}

describe('CatalogSync', () => {
  let dir
  let neverSettle = /** @type {(() => void) | null} */ (null)

  beforeEach(async () => {
    CatalogSync.resetForTests()
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tg-sync-'))
    vi.spyOn(Lock, 'acquire').mockResolvedValue(true)
    vi.spyOn(Lock, 'renew').mockResolvedValue(true)
    vi.spyOn(Lock, 'release').mockResolvedValue(true)
    vi.mocked(CatalogSnapshot.exportSnapshot).mockImplementation(realExport)
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (neverSettle) {
      neverSettle()
      neverSettle = null
    }
    await CatalogSync.stop()
    setCollectionOverrideForTests(null)
    vi.restoreAllMocks()
    vi.mocked(CatalogSnapshot.exportSnapshot).mockReset()
    vi.mocked(CatalogSnapshot.exportSnapshot).mockImplementation(realExport)
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  describe('restoreIfNeeded', () => {
    it.each([
      ['top-level write concern', { writeConcernError: { code: 64 } }],
      [
        'driver write concern accessor',
        { result: { getWriteConcernError: () => ({ code: 64 }) } },
      ],
      [
        'raw write concern',
        {
          result: {
            getRawResponse: () => ({ writeConcernErrors: [{ code: 64 }] }),
          },
        },
      ],
      ['nonduplicate wrapper code', { code: 91 }],
      [
        'nested nonduplicate write error',
        { result: { getWriteErrors: () => [{ code: 121 }] } },
      ],
    ])(
      'retains the progress marker for duplicate errors accompanied by %s',
      async (_name, extra) => {
        installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
        const manifest = await CatalogSnapshot.exportSnapshot({
          storageDir: dir,
        })
        const target = installCollections()
        const failure = Object.assign(new Error('uncertain bulk insert'), {
          name: 'MongoBulkWriteError',
          code: 11000,
          writeErrors: [{ index: 0, code: 11000 }],
          result: { insertedCount: 0 },
          ...extra,
        })
        target[ITEMS].insertMany.mockRejectedValueOnce(failure)
        expect(
          await rejectionOf(CatalogSync.restoreIfNeeded({ storageDir: dir }))
        ).toBe(failure)
        expect(target[CONFIG].store.get('store').restoreState).toBe(
          'in_progress'
        )
        CatalogSync.resetForTests()
        expect(
          (await rejectionOf(realExport({ storageDir: dir, force: true }))).code
        ).toBe('SNAPSHOT_RESTORE_INCOMPLETE')
        expect(
          (await CatalogSnapshot.readCurrentManifest(dir)).generation
        ).toBe(manifest.generation)
        const resumed = await CatalogSync.restoreIfNeeded({ storageDir: dir })
        expect(resumed.action).toBe('restored')
        expect(target[ITEMS].store.size).toBe(1)
        expect(target[CONFIG].store.get('store').restoreState).toBe('done')
      }
    )

    it('resumes 501 items after a failure after the first 500, preserving the complete snapshot', async () => {
      const docs = Array.from({ length: 501 }, (_, i) => ({
        _id: `item-${i}`,
        title: `Item ${i}`,
      }))
      const otherCollections = Object.fromEntries(
        SNAPSHOT_COLLECTIONS.filter((name) => name !== ITEMS).map((name) => [
          name,
          makeFakeCollection([{ _id: `${name}-entry`, value: name }]),
        ])
      )
      installCollections({
        [ITEMS]: makeFakeCollection(docs),
        ...otherCollections,
      })
      const manifest = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
      })
      const target = installCollections()
      const insert = target[ITEMS].insertMany.getMockImplementation()
      target[ITEMS].insertMany
        .mockImplementationOnce(insert)
        .mockRejectedValueOnce(new Error('Mongo interrupted after 500 items'))

      const error = await rejectionOf(
        CatalogSync.restoreIfNeeded({ storageDir: dir })
      )
      expect(error.message).toContain('after 500')
      expect(target[ITEMS].store.size).toBe(500)
      expect(target[CONFIG].store.get('store').restoreState).toBe('in_progress')
      for (const name of SNAPSHOT_COLLECTIONS.filter(
        (name) => name !== ITEMS
      )) {
        expect(target[name].store.size).toBe(1)
      }

      // Reset all process state; only the persisted marker and partial DB remain.
      CatalogSync.resetForTests()
      CatalogSync.start({ storageDir: dir })
      CatalogSync.markDirty('partial restore')
      const blocked = await rejectionOf(CatalogSync.exportNow())
      expect(blocked.code).toBe('SNAPSHOT_RESTORE_INCOMPLETE')
      const direct = await rejectionOf(
        realExport({ storageDir: dir, force: true })
      )
      expect(direct.code).toBe('SNAPSHOT_RESTORE_INCOMPLETE')
      await CatalogSync.stop()
      expect((await CatalogSnapshot.readCurrentManifest(dir)).generation).toBe(
        manifest.generation
      )
      expect(
        (await CatalogSnapshot.readCurrentManifest(dir)).collections[ITEMS]
          .count
      ).toBe(501)
      CatalogSync.resetForTests()

      const result = await CatalogSync.restoreIfNeeded({ storageDir: dir })
      expect(result.action).toBe('restored')
      expect(result.counts[ITEMS]).toBe(1)
      expect(target[ITEMS].store.size).toBe(501)
      expect(target[CONFIG].store.get('store').restoreState).toBe('done')
      for (const name of SNAPSHOT_COLLECTIONS.filter(
        (name) => name !== ITEMS
      )) {
        expect(target[name].store.size).toBe(1)
        expect(result.counts[name]).toBe(0)
      }
      expect(await CatalogSync.restoreIfNeeded({ storageDir: dir })).toEqual({
        action: 'none',
      })
      CatalogSync.start({ storageDir: dir })
      expect((await CatalogSync.exportNow()).collections[ITEMS].count).toBe(501)
    })

    it.each(['storeId', 'generation'])(
      'refuses to mix an interrupted restore with a changed %s',
      async (field) => {
        installCollections({ [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]) })
        const manifest = await CatalogSnapshot.exportSnapshot({
          storageDir: dir,
        })
        const marker = {
          _id: 'store',
          storeId: manifest.storeId,
          generation: manifest.generation,
          restoreState: 'in_progress',
          [field]:
            field === 'generation'
              ? '20260101T000000000-deadbe'
              : 'different-store',
        }
        const target = installCollections({
          [ITEMS]: makeFakeCollection([ITEM_A]),
          [CONFIG]: makeFakeCollection([marker]),
        })
        const error = await rejectionOf(
          CatalogSync.restoreIfNeeded({ storageDir: dir })
        )
        expect(error.code).toBe('SNAPSHOT_RESTORE_MISMATCH')
        expect(target[ITEMS].store.size).toBe(1)
        expect(target[ITEMS].insertMany).not.toHaveBeenCalled()
        expect(target[CONFIG].store.get('store')).toEqual(marker)
        expect(
          (await CatalogSnapshot.readCurrentManifest(dir)).generation
        ).toBe(manifest.generation)
      }
    )

    it('does not insert anything if the durable progress marker cannot be written', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })
      const target = installCollections()
      target[CONFIG].updateOne.mockRejectedValueOnce(
        new Error('marker unavailable')
      )
      expect(
        (await rejectionOf(CatalogSync.restoreIfNeeded({ storageDir: dir })))
          .message
      ).toBe('marker unavailable')
      for (const name of SNAPSHOT_COLLECTIONS)
        expect(target[name].insertMany).not.toHaveBeenCalled()
    })

    it('resumes the pinned generation when the pointer advances in the same store', async () => {
      const source = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]),
      })
      const original = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
      })
      source[ITEMS].store.set('later', {
        _id: 'later',
        title: 'Later generation only',
      })
      const later = await CatalogSnapshot.exportSnapshot({ storageDir: dir })
      const target = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A]),
        [CONFIG]: makeFakeCollection([
          {
            _id: 'store',
            storeId: original.storeId,
            generation: original.generation,
            restoreState: 'in_progress',
          },
        ]),
      })
      const result = await CatalogSync.restoreIfNeeded({ storageDir: dir })
      expect(result.generation).toBe(original.generation)
      expect(target[ITEMS].store.size).toBe(2)
      expect(target[ITEMS].store.has('later')).toBe(false)
      expect((await CatalogSnapshot.readCurrentManifest(dir)).generation).toBe(
        later.generation
      )
    })

    it('does not treat an unreadable marker as permission to use or export a partial catalog', async () => {
      const target = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A]),
      })
      target[CONFIG].findOne.mockRejectedValue(new Error('config unavailable'))
      expect(
        (await rejectionOf(CatalogSync.restoreIfNeeded({ storageDir: dir })))
          .message
      ).toBe('config unavailable')
      expect(
        (await rejectionOf(realExport({ storageDir: dir, force: true })))
          .message
      ).toBe('config unavailable')
      expect(target[ITEMS].insertMany).not.toHaveBeenCalled()
    })

    it('joins concurrent restore requests within one process', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })
      const target = installCollections()
      const first = CatalogSync.restoreIfNeeded({ storageDir: dir })
      const second = CatalogSync.restoreIfNeeded({ storageDir: dir })
      expect(second).toBe(first)
      await Promise.all([first, second])
      expect(target[ITEMS].insertMany).toHaveBeenCalledTimes(1)
      expect(Lock.acquire).toHaveBeenCalledTimes(2)
    })

    it('resumes when the completion marker failed after all documents were inserted', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })
      const target = installCollections()
      const update = target[CONFIG].updateOne.getMockImplementation()
      target[CONFIG].updateOne
        .mockImplementationOnce(update)
        .mockRejectedValueOnce(new Error('completion marker unavailable'))
      await rejectionOf(CatalogSync.restoreIfNeeded({ storageDir: dir }))
      expect(target[ITEMS].store.size).toBe(1)
      expect(target[CONFIG].store.get('store').restoreState).toBe('in_progress')
      CatalogSync.resetForTests()
      const result = await CatalogSync.restoreIfNeeded({ storageDir: dir })
      expect(result.action).toBe('restored')
      expect(result.counts[ITEMS]).toBe(0)
      expect(target[CONFIG].store.get('store').restoreState).toBe('done')
    })

    it('stops importing when either lease is lost and retains the progress marker', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })
      const target = installCollections()
      vi.mocked(Lock.renew)
        .mockResolvedValue(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
      const error = await rejectionOf(
        CatalogSync.restoreIfNeeded({ storageDir: dir })
      )
      expect(error.code).toBe('SNAPSHOT_LEASE_LOST')
      expect(target[ITEMS].insertMany).not.toHaveBeenCalled()
      expect(target[CONFIG].store.get('store').restoreState).toBe('in_progress')
      expect(Lock.release).toHaveBeenCalledWith('snapshot', expect.any(String))
      expect(Lock.release).toHaveBeenCalledWith(
        'snapshot-restore',
        expect.any(String)
      )
    })

    it('restores an empty Items collection from the current snapshot and records the restore', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]) })
      const manifest = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
      })

      const cols = installCollections()
      const result = await CatalogSync.restoreIfNeeded({ storageDir: dir })

      expect(result.action).toBe('restored')
      expect(result.generation).toBe(manifest.generation)
      expect(result.counts[ITEMS]).toBe(2)
      expect(cols[ITEMS].store.size).toBe(2)
      expect(cols[CONFIG].updateOne).toHaveBeenCalledWith(
        { _id: 'store' },
        {
          $set: expect.objectContaining({
            storeId: manifest.storeId,
            generation: manifest.generation,
          }),
        },
        { upsert: true }
      )
    })

    it('never imports into a non-empty Items collection', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })

      const cols = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A]),
      })
      const result = await CatalogSync.restoreIfNeeded({ storageDir: dir })

      expect(result).toEqual({ action: 'none' })
      expect(cols[ITEMS].insertMany).not.toHaveBeenCalled()
      expect(cols[CONFIG].updateOne).not.toHaveBeenCalled()
    })

    it('backfills a snapshot from existing Items when none exists, and exports at start()', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]) })

      const result = await CatalogSync.restoreIfNeeded({ storageDir: dir })
      expect(result).toEqual({ action: 'backfill' })
      expect(await CatalogSnapshot.readCurrentManifest(dir)).toBeNull()

      CatalogSync.start({ storageDir: dir })
      await vi.waitFor(
        async () => {
          expect(await CatalogSnapshot.readCurrentManifest(dir)).not.toBeNull()
        },
        { timeout: 5000 }
      )
      const manifest = await CatalogSnapshot.readCurrentManifest(dir)
      expect(manifest.collections[ITEMS].count).toBe(2)
      expect(manifest.reason).toBe('backfill')
    })

    it('does nothing on a fresh install (no Items and no snapshot), and does not export at start()', async () => {
      installCollections()

      expect(await CatalogSync.restoreIfNeeded({ storageDir: dir })).toEqual({
        action: 'none',
      })
      CatalogSync.start({ storageDir: dir })
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(await CatalogSnapshot.readCurrentManifest(dir)).toBeNull()
      expect(CatalogSync.getStatus()).toMatchObject({
        dirty: false,
        lastGeneration: null,
      })
    })

    it('treats a corrupt snapshot as unusable and leaves Items empty', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      const manifest = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
      })
      await fs.promises.writeFile(
        path.join(
          dir,
          'catalog',
          `gen-${manifest.generation}`,
          `${ITEMS}.jsonl.gz`
        ),
        'garbage'
      )

      const cols = installCollections()
      expect(await CatalogSync.restoreIfNeeded({ storageDir: dir })).toEqual({
        action: 'none',
        reason: 'no_valid_snapshot',
      })
      expect(cols[ITEMS].insertMany).not.toHaveBeenCalled()
    })

    it('falls back to an older valid generation when current is corrupt', async () => {
      // First generation: valid with ITEM_A
      const cols = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A]),
      })
      const first = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
        reason: 'first',
      })

      // Second generation: with ITEM_B
      cols[ITEMS].store.clear()
      cols[ITEMS].store.set(String(ITEM_B._id), ITEM_B)
      const second = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
        reason: 'second',
      })

      // Corrupt second generation's items file
      await fs.promises.writeFile(
        path.join(
          dir,
          'catalog',
          `gen-${second.generation}`,
          `${ITEMS}.jsonl.gz`
        ),
        'corrupt'
      )

      // restoreIfNeeded should fall back to first generation!
      const target = installCollections()
      const result = await CatalogSync.restoreIfNeeded({ storageDir: dir })
      expect(result.action).toBe('restored')
      expect(result.generation).toBe(first.generation)
      expect(target[ITEMS].store.size).toBe(1)
      expect(target[ITEMS].store.has(String(ITEM_A._id))).toBe(true)
    })

    it('resumes an interrupted in_progress restore even when Items is non-empty', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A, ITEM_B]) })
      const manifest = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
      })

      // Partially populated Items + in_progress marker
      const target = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A]),
        [CONFIG]: makeFakeCollection([
          {
            _id: 'store',
            storeId: manifest.storeId,
            generation: manifest.generation,
            restoreState: 'in_progress',
          },
        ]),
      })

      const result = await CatalogSync.restoreIfNeeded({ storageDir: dir })
      expect(result.action).toBe('restored')
      expect(result.generation).toBe(manifest.generation)
      expect(target[ITEMS].store.size).toBe(2)
      expect(target[CONFIG].updateOne).toHaveBeenCalledWith(
        { _id: 'store' },
        expect.objectContaining({
          $set: expect.objectContaining({ restoreState: 'done' }),
        }),
        expect.anything()
      )
    })

    it('waits when another process holds snapshot-restore lock', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      const manifest = await CatalogSnapshot.exportSnapshot({
        storageDir: dir,
      })

      const target = installCollections({
        [ITEMS]: makeFakeCollection([ITEM_A]),
        [CONFIG]: makeFakeCollection([
          {
            _id: 'store',
            storeId: manifest.storeId,
            generation: manifest.generation,
            restoreState: 'done',
          },
        ]),
      })

      // Simulate lock held by another process
      target[ITEMS].findOne.mockResolvedValueOnce(null)
      vi.spyOn(Lock, 'acquire').mockResolvedValue(false)

      const result = await CatalogSync.restoreIfNeeded({
        storageDir: dir,
        restoreWaitMs: 100,
      })
      expect(result).toEqual({
        action: 'waited',
        generation: manifest.generation,
      })
    })

    it('surfaces transient import errors so the caller can fail closed', async () => {
      installCollections({ [ITEMS]: makeFakeCollection([ITEM_A]) })
      await CatalogSnapshot.exportSnapshot({ storageDir: dir })

      const broken = makeFakeCollection()
      broken.insertMany.mockRejectedValueOnce(
        Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
      )
      const cols = installCollections({ [ITEMS]: broken })

      const err = await rejectionOf(
        CatalogSync.restoreIfNeeded({ storageDir: dir })
      )
      expect(err.message).toBe('connection reset')
      expect(cols[CONFIG].updateOne).toHaveBeenCalledWith(
        { _id: 'store' },
        expect.objectContaining({
          $set: expect.objectContaining({ restoreState: 'in_progress' }),
        }),
        expect.anything()
      )
      expect(cols[CONFIG].updateOne).not.toHaveBeenCalledWith(
        { _id: 'store' },
        expect.objectContaining({
          $set: expect.objectContaining({ restoreState: 'done' }),
        }),
        expect.anything()
      )
    })
  })

  describe('export scheduling', () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      })
      installCollections()
      vi.mocked(CatalogSnapshot.exportSnapshot).mockImplementation(async () =>
        fakeManifest()
      )
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    const exportCalls = () =>
      vi.mocked(CatalogSnapshot.exportSnapshot).mock.calls.length

    it('reports a clean status at boot', () => {
      expect(CatalogSync.getStatus()).toEqual({
        dirty: false,
        lastExportAt: null,
        lastGeneration: null,
        lastError: null,
        exporting: false,
      })
    })

    it('debounces: exports 30s after the last write', async () => {
      CatalogSync.start({ storageDir: dir })
      CatalogSync.markDirty('a')
      await vi.advanceTimersByTimeAsync(29_000)
      await flush()
      expect(exportCalls()).toBe(0)

      CatalogSync.markDirty('b')
      await vi.advanceTimersByTimeAsync(29_000)
      await flush()
      expect(exportCalls()).toBe(0)

      await vi.advanceTimersByTimeAsync(1_000)
      await flush()
      expect(exportCalls()).toBe(1)
      expect(CatalogSync.getStatus()).toMatchObject({
        dirty: false,
        lastGeneration: 'g-1',
      })
    })

    it('caps the wait at 10 minutes under continuous writes', async () => {
      CatalogSync.start({ storageDir: dir })
      for (let i = 0; i < 29; i++) {
        CatalogSync.markDirty('busy')
        await vi.advanceTimersByTimeAsync(20_000)
      }
      await flush()
      expect(exportCalls()).toBe(0)

      CatalogSync.markDirty('busy')
      await vi.advanceTimersByTimeAsync(20_000)
      await flush()
      expect(exportCalls()).toBe(1)
    })

    it('keeps writes that arrive during an export dirty and exports again', async () => {
      let release = () => {}
      vi.mocked(CatalogSnapshot.exportSnapshot).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(fakeManifest('g-1'))
          })
      )
      CatalogSync.start({ storageDir: dir })
      CatalogSync.markDirty('a')
      await vi.advanceTimersByTimeAsync(30_000)
      await flush()
      expect(exportCalls()).toBe(1)
      expect(CatalogSync.getStatus().exporting).toBe(true)

      CatalogSync.markDirty('during-export')
      release()
      await flush()
      expect(CatalogSync.getStatus()).toMatchObject({
        dirty: true,
        exporting: false,
        lastGeneration: 'g-1',
      })

      await vi.advanceTimersByTimeAsync(30_000)
      await flush()
      expect(exportCalls()).toBe(2)
      expect(CatalogSync.getStatus().dirty).toBe(false)
    })

    it('takes the snapshot lease with an owner id for each export and releases it afterwards', async () => {
      CatalogSync.start({ storageDir: dir })
      CatalogSync.markDirty('a')
      await vi.advanceTimersByTimeAsync(30_000)
      await flush()

      expect(Lock.acquire).toHaveBeenCalledWith(
        'snapshot',
        expect.stringMatching(LEASE_OWNER),
        expect.any(Number),
        5 * 60_000
      )
      const owner = vi.mocked(Lock.acquire).mock.calls[0][1]
      expect(Lock.release).toHaveBeenCalledWith('snapshot', owner)
    })

    it('stays dirty while another process holds the lease, then exports on the retry', async () => {
      vi.mocked(Lock.acquire).mockResolvedValueOnce(false)
      CatalogSync.start({ storageDir: dir })
      CatalogSync.markDirty('a')
      await vi.advanceTimersByTimeAsync(30_000)
      await flush()
      expect(exportCalls()).toBe(0)
      expect(CatalogSync.getStatus()).toMatchObject({
        dirty: true,
        lastError: null,
      })

      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await flush()
      expect(exportCalls()).toBe(1)
      expect(CatalogSync.getStatus().dirty).toBe(false)
    })

    it('records a failed export, stays dirty, and retries after 5 minutes', async () => {
      vi.mocked(CatalogSnapshot.exportSnapshot).mockRejectedValueOnce(
        new Error('disk full')
      )
      CatalogSync.start({ storageDir: dir })
      CatalogSync.markDirty('a')
      await vi.advanceTimersByTimeAsync(30_000)
      await flush()
      expect(CatalogSync.getStatus()).toMatchObject({
        dirty: true,
        lastError: 'disk full',
      })

      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await flush()
      expect(exportCalls()).toBe(2)
      expect(CatalogSync.getStatus()).toMatchObject({
        dirty: false,
        lastError: null,
      })
    })

    it('stop() exports pending writes once, and later writes schedule nothing', async () => {
      CatalogSync.start({ storageDir: dir })
      CatalogSync.markDirty('a')
      await CatalogSync.stop()
      expect(exportCalls()).toBe(1)

      CatalogSync.markDirty('late')
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      await flush()
      expect(exportCalls()).toBe(1)
    })

    it('stop() is bounded to 20s when the final export hangs', async () => {
      vi.mocked(CatalogSnapshot.exportSnapshot).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            neverSettle = () => resolve(fakeManifest('never'))
          })
      )
      CatalogSync.start({ storageDir: dir })
      CatalogSync.markDirty('a')

      const stopping = CatalogSync.stop()
      await vi.advanceTimersByTimeAsync(20_000)
      // Resolves only because the 20s bound fired; the export is still hanging.
      await stopping
      expect(CatalogSync.getStatus().exporting).toBe(true)
    })

    it('uses unref-ed timers so they never keep the process alive', async () => {
      vi.useRealTimers()
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      const intervalSpy = vi.spyOn(globalThis, 'setInterval')

      CatalogSync.start({ storageDir: dir })
      CatalogSync.markDirty('a')

      const timers = [
        ...timeoutSpy.mock.results,
        ...intervalSpy.mock.results,
      ].map((r) => r.value)
      expect(timers.length).toBeGreaterThan(0)
      for (const timer of timers) {
        expect(timer.hasRef()).toBe(false)
      }
      await CatalogSync.stop()
    })
  })
})
