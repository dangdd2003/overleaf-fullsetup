import { describe, it, expect, afterEach, vi } from 'vitest'

const mongo = vi.hoisted(() => {
  const handles = new Map()
  const WRITE_METHODS = [
    'insertOne',
    'insertMany',
    'updateOne',
    'updateMany',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'bulkWrite',
    'findOneAndUpdate',
    'findOneAndReplace',
    'findOneAndDelete',
  ]
  /** @param {string} name */
  const makeHandle = name => {
    const handle = {
      name,
      findOne: vi.fn(async () => null),
      find: vi.fn(() => []),
    }
    for (const method of WRITE_METHODS) {
      handle[method] = vi.fn(async () => ({ acknowledged: true }))
    }
    return handle
  }
  return {
    handles,
    WRITE_METHODS,
    getCollectionInternal: vi.fn(async name => {
      if (!handles.has(name)) handles.set(name, makeHandle(name))
      return handles.get(name)
    }),
  }
})

vi.mock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
  getCollectionInternal: mongo.getCollectionInternal,
}))

const {
  SNAPSHOT_COLLECTIONS,
  collectionByName,
  onWrite,
  setCollectionOverrideForTests,
} = await import('../../../app/src/persistence/Collections.mjs')

describe('Collections write notification', () => {
  const unsubscribers = []

  afterEach(() => {
    while (unsubscribers.length) unsubscribers.pop()()
    setCollectionOverrideForTests(null)
  })

  /** @param {(name: string, method: string) => void} fn */
  function listen(fn) {
    const listener = vi.fn(fn)
    unsubscribers.push(onWrite(listener))
    return listener
  }

  it('lists the four rebuildable collections and freezes the list', () => {
    expect(Object.isFrozen(SNAPSHOT_COLLECTIONS)).toBe(true)
    expect([...SNAPSHOT_COLLECTIONS]).toEqual([
      'templateGalleryItems',
      'templateGalleryTags',
      'templateGalleryListings',
      'templateGalleryCrawlerState',
    ])
  })

  it('notifies listeners after a successful write on a real snapshot handle', async () => {
    const listener = listen(() => {})
    const col = await collectionByName('templateGalleryItems')

    await col.insertOne({ _id: 1 })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('templateGalleryItems', 'insertOne')
  })

  it('notifies for every write method in the contract', async () => {
    const listener = listen(() => {})
    const col = await collectionByName('templateGalleryTags')

    for (const method of mongo.WRITE_METHODS) {
      await col[method]({})
    }

    expect(listener.mock.calls.map(call => call[1])).toEqual(
      mongo.WRITE_METHODS
    )
    expect(
      listener.mock.calls.every(call => call[0] === 'templateGalleryTags')
    ).toBe(true)
  })

  it('does not notify for reads, and passes them through to the raw handle', async () => {
    const listener = listen(() => {})
    const col = await collectionByName('templateGalleryListings')

    await col.findOne({})

    expect(listener).not.toHaveBeenCalled()
    expect(col.name).toBe('templateGalleryListings')
    expect(
      mongo.handles.get('templateGalleryListings').findOne
    ).toHaveBeenCalledWith({})
  })

  it('does not notify when the driver write rejects', async () => {
    const listener = listen(() => {})
    const col = await collectionByName('templateGalleryCrawlerState')
    mongo.handles
      .get('templateGalleryCrawlerState')
      .deleteOne.mockRejectedValueOnce(new Error('write failed'))

    const outcome = await col.deleteOne({}).then(
      () => null,
      err => err
    )

    expect(outcome.message).toBe('write failed')
    expect(listener).not.toHaveBeenCalled()
  })

  it('wraps each snapshot handle once and returns the same wrapper', async () => {
    const first = await collectionByName('templateGalleryAudit')
    const second = await collectionByName('templateGalleryAudit')
    expect(second).toBe(first)
  })

  it('does not wrap collections outside the snapshot', async () => {
    const listener = listen(() => {})
    const jobs = await collectionByName('templateGalleryJobs')

    expect(jobs).toBe(mongo.handles.get('templateGalleryJobs'))
    await jobs.insertOne({ _id: 1 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('honours test overrides without wrapping them', async () => {
    const listener = listen(() => {})
    const fake = { insertOne: vi.fn(async () => ({})) }
    setCollectionOverrideForTests({ templateGalleryItems: fake })

    expect(await collectionByName('templateGalleryItems')).toBe(fake)
    await fake.insertOne({})
    expect(listener).not.toHaveBeenCalled()
  })

  it('only notifies when the write has an actual effect', async () => {
    const listener = listen(() => {})
    const col = await collectionByName('templateGalleryItems')
    const handle = mongo.handles.get('templateGalleryItems')

    // No-op update: matched 1, modified 0
    handle.updateOne.mockResolvedValueOnce({
      matchedCount: 1,
      modifiedCount: 0,
    })
    await col.updateOne({ _id: 1 }, { $set: { a: 1 } })
    expect(listener).not.toHaveBeenCalled()

    // Effective update: modified 1
    handle.updateOne.mockResolvedValueOnce({
      matchedCount: 1,
      modifiedCount: 1,
    })
    await col.updateOne({ _id: 1 }, { $set: { a: 2 } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('templateGalleryItems', 'updateOne')
  })

  it('keeps writing and notifying other listeners when one listener throws', async () => {
    const broken = listen(() => {
      throw new Error('listener bug')
    })
    const healthy = listen(() => {})
    const col = await collectionByName('templateGalleryItems')

    const result = await col.updateOne({}, {})
    expect(result).toEqual({ acknowledged: true })
    expect(broken).toHaveBeenCalled()
    expect(healthy).toHaveBeenCalledWith('templateGalleryItems', 'updateOne')
  })

  it('stops notifying after unsubscribe', async () => {
    const listener = vi.fn()
    const unsubscribe = onWrite(listener)
    const col = await collectionByName('templateGalleryItems')
    unsubscribe()

    await col.insertOne({ _id: 2 })
    expect(listener).not.toHaveBeenCalled()
  })
})
