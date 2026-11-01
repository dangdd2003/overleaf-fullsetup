import { logWarn } from '../observability/Log.mjs'

let mongoModule = null

async function loadMongodbInternal() {
  if (!mongoModule) {
    mongoModule =
      await import('../../../../../app/src/infrastructure/mongodb.mjs')
  }
  return mongoModule.getCollectionInternal
}

const COLLECTION_OVERRIDE_SYMBOL = Symbol.for(
  'overleaf.templateGallery.collectionOverrides'
)

/**
 * Injects an in-memory/mock collection map for unit tests so they can run without a live MongoDB server.
 * Passing null resets the override.
 *
 * @param {Record<string, any> | null} map
 */
export function setCollectionOverrideForTests(map) {
  globalThis[COLLECTION_OVERRIDE_SYMBOL] = map
}

/**
 * Names of collections mirrored into the volume snapshot (storage/CatalogSnapshot.mjs).
 * They are rebuildable and instance-independent. Jobs, locks and the encrypted config are not listed.
 */
export const SNAPSHOT_COLLECTIONS = Object.freeze([
  'templateGalleryItems',
  'templateGalleryTags',
  'templateGalleryListings',
  'templateGalleryCrawlerState',
])

const SNAPSHOT_COLLECTION_SET = new Set(SNAPSHOT_COLLECTIONS)

// Driver methods that change data. A successful call notifies onWrite listeners.
const WRITE_METHODS = new Set([
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
])

/** @type {Set<(collectionName: string, method: string) => void>} */
const writeListeners = new Set()

/** @type {Map<string, any>} */
const wrappedCollections = new Map()

/**
 * Subscribes to successful writes on snapshot collections. Listeners run after the driver
 * promise resolves. A throwing listener is logged and does not affect the write.
 *
 * @param {(collectionName: string, method: string) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onWrite(listener) {
  writeListeners.add(listener)
  return () => {
    writeListeners.delete(listener)
  }
}

/**
 * @param {string} collectionName
 * @param {string} method
 */
function notifyWrite(collectionName, method) {
  for (const listener of writeListeners) {
    try {
      listener(collectionName, method)
    } catch (err) {
      logWarn('write_listener_failed', {
        collectionName,
        method,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * Checks whether a driver write result indicates an actual state change.
 * If unrecognized or missing, defaults to true so mock handles in tests still notify.
 *
 * @param {any} result
 * @returns {boolean}
 */
function hasWriteEffect(result) {
  if (result == null || typeof result !== 'object') {
    return true
  }
  const hasCountProp =
    'insertedCount' in result ||
    'modifiedCount' in result ||
    'upsertedCount' in result ||
    'deletedCount' in result
  if (hasCountProp) {
    return (
      (result.insertedCount ?? 0) > 0 ||
      (result.modifiedCount ?? 0) > 0 ||
      (result.upsertedCount ?? 0) > 0 ||
      (result.deletedCount ?? 0) > 0 ||
      result.insertedId != null ||
      result.upsertedId != null
    )
  }
  if ('matchedCount' in result) {
    return (result.modifiedCount ?? 0) > 0 || (result.upsertedCount ?? 0) > 0
  }
  if ('value' in result) {
    return result.value != null
  }
  return true
}

/**
 * Wraps a real driver collection. Successful write methods notify onWrite listeners;
 * everything else passes through to the raw handle (functions are bound to it).
 *
 * @param {string} collectionName
 * @param {any} handle
 * @returns {any}
 */
function wrapSnapshotCollection(collectionName, handle) {
  return new Proxy(handle, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') {
        return value
      }
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return (...args) =>
          Promise.resolve(value.apply(target, args)).then(result => {
            if (hasWriteEffect(result)) {
              notifyWrite(collectionName, prop)
            }
            return result
          })
      }
      return value.bind(target)
    },
  })
}

/**
 * Returns a collection instance, honoring test overrides if set. Real handles of
 * SNAPSHOT_COLLECTIONS are wrapped once (cached) so their writes notify onWrite.
 *
 * @param {string} name
 * @returns {Promise<any>}
 */
async function getCol(name) {
  const overrides = globalThis[COLLECTION_OVERRIDE_SYMBOL]
  if (overrides && overrides[name]) {
    return overrides[name]
  }
  if (wrappedCollections.has(name)) {
    return wrappedCollections.get(name)
  }
  const getCollectionInternal = await loadMongodbInternal()
  const handle = await getCollectionInternal(name)
  if (!SNAPSHOT_COLLECTION_SET.has(name)) {
    return handle
  }
  if (!wrappedCollections.has(name)) {
    wrappedCollections.set(name, wrapSnapshotCollection(name, handle))
  }
  return wrappedCollections.get(name)
}

/**
 * Raw getter by collection name (honours test overrides).
 *
 * @param {string} name
 * @returns {Promise<any>}
 */
export async function collectionByName(name) {
  return getCol(name)
}

/**
 * Collection storing crawled/hydrated template catalog items.
 */
export async function itemsCol() {
  return getCol('templateGalleryItems')
}

/**
 * Collection storing facet partition crawler checkpoint state.
 */
export async function crawlerStateCol() {
  return getCol('templateGalleryCrawlerState')
}

/**
 * Collection storing background job queue entries (gc, integrity).
 */
export async function jobsCol() {
  return getCol('templateGalleryJobs')
}

/**
 * Collection storing cluster-wide distributed locks and pause flags.
 */
export async function locksCol() {
  return getCol('templateGalleryLocks')
}

/**
 * Collection storing the store identity, the snapshot restore marker, GC usage
 * metrics, the upstream Algolia config and the encrypted session cookie.
 */
export async function configCol() {
  return getCol('templateGalleryConfig')
}

/**
 * Collection storing per-tag mirror metadata (canonical title, summaries,
 * related tags and top picks scraped from the official tag pages).
 */
export async function tagsCol() {
  return getCol('templateGalleryTags')
}

/**
 * Collection storing curated listing slots (featured blocks) and scan checkpoints.
 */
export async function listingsCol() {
  return getCol('templateGalleryListings')
}

export default {
  setCollectionOverrideForTests,
  SNAPSHOT_COLLECTIONS,
  onWrite,
  collectionByName,
  tagsCol,
  listingsCol,
  itemsCol,
  crawlerStateCol,
  jobsCol,
  locksCol,
  configCol,
}
