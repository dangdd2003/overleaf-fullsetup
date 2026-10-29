let mongoModule = null

async function loadMongodbInternal() {
  if (!mongoModule) {
    mongoModule = await import('../../../../../app/src/infrastructure/mongodb.mjs')
  }
  return mongoModule.getCollectionInternal
}

const COLLECTION_OVERRIDE_SYMBOL = Symbol.for('overleaf.templateGallery.collectionOverrides')

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
 * Returns a collection instance, honoring test overrides if set.
 *
 * @param {string} name
 * @returns {Promise<any>}
 */
async function getCol(name) {
  const overrides = globalThis[COLLECTION_OVERRIDE_SYMBOL]
  if (overrides && overrides[name]) {
    return overrides[name]
  }
  const getCollectionInternal = await loadMongodbInternal()
  return getCollectionInternal(name)
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
 * Collection storing background and validation job queue entries.
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
 * Collection storing runtime configuration overrides and encrypted secrets.
 */
export async function configCol() {
  return getCol('templateGalleryConfig')
}

/**
 * Collection storing administrative audit trail entries.
 */
export async function auditCol() {
  return getCol('templateGalleryAudit')
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
  tagsCol,
  listingsCol,
  itemsCol,
  crawlerStateCol,
  jobsCol,
  locksCol,
  configCol,
  auditCol,
}
