import { locksCol } from '../persistence/Collections.mjs'

/**
 * Distributed lock and pause manager backed by MongoDB templateGalleryLocks.
 * Handles distributed worker coordination, exclusive task leases, and administrative pauses.
 */

/**
 * Attempts to acquire or re-acquire an exclusive lease on lockId.
 *
 * @param {string} lockId
 * @param {string} owner
 * @param {number} [nowMs=Date.now()]
 * @param {number} [leaseMs=600_000]
 * @returns {Promise<boolean>}
 */
export async function acquire(lockId, owner, nowMs = Date.now(), leaseMs = 600_000) {
  try {
    const col = await locksCol()
    const filter = {
      _id: lockId,
      $or: [
        { leaseExpiresAt: { $lte: nowMs } },
        { leaseOwner: owner },
        { leaseOwner: null },
      ],
    }
    const update = {
      $set: {
        leaseOwner: owner,
        leaseExpiresAt: nowMs + leaseMs,
        updatedAt: new Date(nowMs),
      },
    }
    const res = await col.updateOne(filter, update, { upsert: true })
    const matchedCount = res?.matchedCount ?? 0
    const upsertedCount = res?.upsertedCount ?? (res?.upsertedId ? 1 : 0)
    return matchedCount > 0 || upsertedCount > 0
  } catch (err) {
    if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
      return false
    }
    throw err
  }
}

/**
 * Renews an active lease if still held by owner.
 *
 * @param {string} lockId
 * @param {string} owner
 * @param {number} [leaseMs=600_000]
 * @param {number} [nowMs=Date.now()]
 * @returns {Promise<boolean>}
 */
export async function renew(lockId, owner, leaseMs = 600_000, nowMs = Date.now()) {
  const col = await locksCol()
  const filter = {
    _id: lockId,
    leaseOwner: owner,
  }
  const update = {
    $set: {
      leaseExpiresAt: nowMs + leaseMs,
      updatedAt: new Date(nowMs),
    },
  }
  const res = await col.updateOne(filter, update)
  const matchedCount = res?.matchedCount ?? 0
  return matchedCount > 0
}

/**
 * Releases an active lease if held by owner.
 *
 * @param {string} lockId
 * @param {string} owner
 * @returns {Promise<boolean>}
 */
export async function release(lockId, owner) {
  const col = await locksCol()
  const filter = {
    _id: lockId,
    leaseOwner: owner,
  }
  const update = {
    $set: {
      leaseOwner: null,
      leaseExpiresAt: 0,
      updatedAt: new Date(),
    },
  }
  const res = await col.updateOne(filter, update)
  const matchedCount = res?.matchedCount ?? 0
  return matchedCount > 0
}

/**
 * Reads the current lock state.
 *
 * @param {string} lockId
 * @returns {Promise<any | null>}
 */
export async function read(lockId) {
  const col = await locksCol()
  return col.findOne({ _id: lockId })
}

/**
 * Pauses operations governed by lockId.
 *
 * @param {string} lockId
 * @param {string} pausedBy
 * @returns {Promise<boolean>}
 */
export async function pause(lockId, pausedBy) {
  const col = await locksCol()
  const filter = { _id: lockId }
  const update = {
    $set: {
      paused: true,
      pausedBy: String(pausedBy),
      pausedAt: new Date(),
      updatedAt: new Date(),
    },
  }
  const res = await col.updateOne(filter, update, { upsert: true })
  return (res?.matchedCount ?? 0) > 0 || (res?.upsertedCount ?? 0) > 0 || !!res?.upsertedId
}

/**
 * Resumes operations governed by lockId.
 *
 * @param {string} lockId
 * @returns {Promise<boolean>}
 */
export async function resume(lockId) {
  const col = await locksCol()
  const filter = { _id: lockId }
  const update = {
    $set: {
      paused: false,
      pausedBy: null,
      pausedAt: null,
      updatedAt: new Date(),
    },
  }
  const res = await col.updateOne(filter, update, { upsert: true })
  return (res?.matchedCount ?? 0) > 0 || (res?.upsertedCount ?? 0) > 0 || !!res?.upsertedId
}

export default {
  acquire,
  renew,
  release,
  read,
  pause,
  resume,
}
