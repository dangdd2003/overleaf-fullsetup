// overleaf/services/web/modules/template-gallery/app/src/jobs/SyncSettings.mjs
import { configCol } from '../persistence/Collections.mjs'

// Admin settings, stored in the config collection and read through a short
// cache because the sync asks often:
//   autoSync     off by default: nothing is fetched from overleaf.com unless
//                an admin clicks "Sync now". When on, a sync runs every
//                refetchDays days.
//   refetchDays  a template synced longer ago than this is fetched again
const DOC_ID = 'syncSettings'
const DAY = 24 * 60 * 60 * 1000
export const DEFAULT_REFETCH_DAYS = 7
export const MIN_REFETCH_DAYS = 1
export const MAX_REFETCH_DAYS = 365
const CACHE_MS = 30_000

let cached = null

/**
 * @returns {Promise<{ autoSync: boolean, refetchDays: number }>}
 */
export async function get() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const col = await configCol()
  const doc = await col.findOne({ _id: DOC_ID })
  const value = {
    autoSync: doc?.autoSync === true,
    refetchDays: parseRefetchDays(doc?.refetchDays) ?? DEFAULT_REFETCH_DAYS,
  }
  cached = { at: Date.now(), value }
  return value
}

export async function refetchIntervalMs() {
  return (await get()).refetchDays * DAY
}

/**
 * A whole number of days within the allowed range, or null.
 */
export function parseRefetchDays(value) {
  const days = Number(value)
  if (!Number.isInteger(days)) return null
  if (days < MIN_REFETCH_DAYS || days > MAX_REFETCH_DAYS) return null
  return days
}

/**
 * Saves the given settings; omitted ones are kept. Throws code
 * 'invalid_refetch_days' or 'invalid_auto_sync' for a bad value.
 */
export async function save({ autoSync, refetchDays } = {}) {
  const set = {}
  if (refetchDays !== undefined) {
    set.refetchDays = parseRefetchDays(refetchDays)
    if (set.refetchDays === null) {
      throw codedError('invalid_refetch_days', `invalid refetch days: ${refetchDays}`)
    }
  }
  if (autoSync !== undefined) {
    if (typeof autoSync !== 'boolean') {
      throw codedError('invalid_auto_sync', 'autoSync must be true or false')
    }
    set.autoSync = autoSync
  }
  const col = await configCol()
  await col.updateOne(
    { _id: DOC_ID },
    { $set: { ...set, updatedAt: new Date() } },
    { upsert: true }
  )
  cached = null
  return get()
}

function codedError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

export function resetForTests() {
  cached = null
}

export default {
  get,
  refetchIntervalMs,
  parseRefetchDays,
  save,
  resetForTests,
  DEFAULT_REFETCH_DAYS,
  MIN_REFETCH_DAYS,
  MAX_REFETCH_DAYS,
}
