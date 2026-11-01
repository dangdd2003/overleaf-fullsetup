import { itemsCol } from '../persistence/Collections.mjs'
import { isValidToken } from '../util/GalleryUrls.mjs'
import * as MirrorService from './mirror/MirrorService.mjs'
import { findItemDoc } from './CatalogueService.mjs'

// Refreshes one item's mirrored detail page (and its PDF preview) from
// overleaf.com. Synchronous: the admin waits on the response.

// An admin is waiting on the response; a PDF can take a while to stream.
const HYDRATE_TIMEOUT_MS = 120_000

/**
 * Refreshes one item's mirrored detail (and PDF) from overleaf.com. Accepts a
 * token, Mongo id, objectID or slug. Returns the stored item, or null when no
 * such item exists; throws when the upstream refresh fails.
 *
 * @param {string} id
 * @param {{ force?: boolean, timeoutMs?: number }} [opts]
 * @returns {Promise<object|null>} raw templateGalleryItems document
 */
export async function hydrateItem(id, opts = {}) {
  const found = await findItemDoc(id, { token: 1 })
  if (!found) return null
  const col = await itemsCol()
  if (!isValidToken(found.token)) return col.findOne({ _id: found._id })

  const ensureOpts = {
    priority: 'interactive',
    force: Boolean(opts.force),
    timeoutMs: opts.timeoutMs ?? HYDRATE_TIMEOUT_MS,
    throwOnError: true,
  }
  const detailed = await MirrorService.ensureDetail(found.token, ensureOpts)

  if (detailed) {
    await MirrorService.ensurePdf(found.token, { ...ensureOpts, throwOnError: false })
  }
  return col.findOne({ _id: found._id })
}

export default {
  hydrateItem,
}
