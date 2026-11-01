import { itemsCol, configCol } from '../persistence/Collections.mjs'
import BlobStore from '../storage/BlobStore.mjs'
import SessionCredentialStore from '../crypto/SessionCredentialStore.mjs'
import { ensureDetail } from './mirror/MirrorService.mjs'
import { acquireViaCloudSession } from './tiers/Tier1SessionAcquisition.mjs'
import {
  acquireViaSynthesis,
  sourceTextSha,
} from './tiers/Tier3SynthesisAcquisition.mjs'
import { resolveStorageDir } from './tiers/TierSupport.mjs'
import { isTransientCode } from '../transport/HostLimiter.mjs'
import { logInfo, logWarn } from '../observability/Log.mjs'

// Finds or builds the project zip for a gallery item:
//   cached zip -> Tier 1 (stored overleaf.com session) -> Tier 3 (single-file
//   synthesis from the mirrored main .tex).
//
// Full-source packages are reused as long as the blob exists, including those
// cached by previous versions of the module.
// A cached Tier 3 zip is reused too, but rebuilt when the mirrored main file
// changed, and Tier 1 is retried once whenever an admin stores a (new)
// session cookie after the zip was built.
//
// A failed attempt is remembered on the item (`acquisitionBackoff`, plus
// `zip.attemptedAt` for a cached zip), so repeated "Open as Template" clicks
// do not repeat the upstream work (Tier 1 creates and deletes a project on
// overleaf.com). The wait doubles with each consecutive failure, up to a cap,
// and a session cookie stored after the failed attempt lifts it at once.

const FULL_SOURCE_TIERS = new Set([1, 2])
const BACKOFF_BASE_MS = 5 * 60_000
const BACKOFF_MAX_MS = 6 * 60 * 60_000

const inflight = new Map()

function backoffDelayMs(failures) {
  return Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(failures - 1, 0),
    BACKOFF_MAX_MS
  )
}

// A failed upgrade keeps serving the cached zip. An admin refetch must not
// report that as a success, so the result carries refetchFailed.
function servedCached(cached, opts) {
  return opts.force ? { ...cached, refetchFailed: true } : cached
}

async function cachedSource(item, storageDir) {
  const sha = item.sourceBlobStoreKey || item.zip?.sha256
  if (!sha || !(await BlobStore.exists(sha, storageDir))) return null
  return {
    acquired: true,
    cached: true,
    tier: item.acquisitionTier || item.zip?.tier || null,
    zipSha256: sha,
    mainFile: item.zip?.mainFile || item.mainFile || null,
    hasMissingDependencies: Boolean(item.hasMissingDependencies),
    missingFiles: item.missingFiles || [],
  }
}

async function sessionStoredSince(since) {
  try {
    const state = await SessionCredentialStore.getSessionCredentialState(
      await configCol()
    )
    if (!state) return false
    return (
      !since || !state.updatedAt || new Date(state.updatedAt) > new Date(since)
    )
  } catch (err) {
    logWarn('session_state_read_failed', { err: err.message })
    return false
  }
}

// True while a recent failed attempt still suppresses a new one: the backoff
// has not run out and no session cookie was stored after that attempt.
async function inBackoff(backoff) {
  if (!backoff?.retryAt || new Date(backoff.retryAt) <= new Date()) return false
  return !(await sessionStoredSince(backoff.attemptedAt))
}

async function canReuse(cached, item) {
  if (FULL_SOURCE_TIERS.has(cached.tier)) return true
  if (cached.tier !== 3) return false
  if (
    item.zip?.sourceTextSha &&
    item.mainText &&
    item.zip.sourceTextSha !== sourceTextSha(item.mainText)
  ) {
    // rebuild for the changed main file, but not again while backing off
    return inBackoff(item.acquisitionBackoff)
  }
  return !(await sessionStoredSince(item.zip?.attemptedAt))
}

// Crawled items only carry Algolia data until their detail page is mirrored;
// the tiers need the CTA params (Tier 1) and the main file text (Tier 3).
async function withDetail(item) {
  if (!item.token) return item
  if (item.mainText && item.publishedId != null) return item
  try {
    return (await ensureDetail(item.token, { priority: 'interactive' })) || item
  } catch (err) {
    logWarn('ensure_detail_failed', {
      token: item.token,
      code: err?.code,
      err: err?.message,
    })
    return item
  }
}

async function runTiers(item, cfg, opts) {
  const tiers = [
    [1, acquireViaCloudSession],
    [3, acquireViaSynthesis],
  ]
  const reasons = []
  let hasTransient = false
  for (const [tier, acquireFn] of tiers) {
    try {
      const result = await acquireFn(item, cfg, opts)
      if (result?.acquired) return { result, reasons, transient: false }
      if (
        result?.transient ||
        isTransientCode(result?.code) ||
        result?.reason === 'upstream_busy'
      ) {
        hasTransient = true
      }
      reasons.push(`tier${tier}:${result?.reason || 'unknown'}`)
    } catch (err) {
      if (isTransientCode(err?.code)) {
        hasTransient = true
      }
      logWarn('tier_attempt_failed', {
        token: item.token,
        tier,
        err: err?.message,
      })
      reasons.push(`tier${tier}:error`)
    }
  }
  return { result: null, reasons, transient: hasTransient }
}

async function persist(item, result, attemptedAt) {
  const zip = {
    sha256: result.zipSha256,
    sizeBytes: result.sizeBytes,
    entryCount: result.entryCount,
    uncompressedBytes: result.uncompressedBytes,
    mainFile: result.mainFile || null,
    tier: result.tier,
    sourceTextSha: result.sourceTextSha || null,
    acquiredAt: new Date(),
    attemptedAt,
  }
  const col = await itemsCol()
  await col.updateOne(
    { _id: item._id },
    {
      $set: {
        sourceAcquired: true,
        sourceBlobStoreKey: result.zipSha256,
        acquisitionTier: result.tier,
        hasMissingDependencies: Boolean(result.hasMissingDependencies),
        missingFiles: result.missingFiles || [],
        zip,
      },
      $unset: { acquisitionBackoff: '' },
    }
  )
}

// Records a failed attempt so that the following ones wait out the backoff.
async function recordFailure(item, attemptedAt, reasons, cached) {
  // only failures close together count as consecutive
  const previous = item.acquisitionBackoff
  const recent =
    previous?.attemptedAt &&
    attemptedAt - new Date(previous.attemptedAt) < BACKOFF_MAX_MS
  const failures = (recent ? previous.failures || 0 : 0) + 1
  const backoff = {
    attemptedAt,
    retryAt: new Date(attemptedAt.getTime() + backoffDelayMs(failures)),
    failures,
    reasons,
  }
  const set = { acquisitionBackoff: backoff }
  if (cached && item.zip && typeof item.zip === 'object') {
    set['zip.attemptedAt'] = attemptedAt
  }
  try {
    const col = await itemsCol()
    await col.updateOne({ _id: item._id }, { $set: set })
  } catch (err) {
    logWarn('acquisition_backoff_write_failed', {
      token: item.token,
      err: err?.message,
    })
  }
}

async function acquireUncached(item, opts) {
  const cfg = opts.cfg || {}
  const storageDir = resolveStorageDir(cfg, opts.storageDir)

  const cached = await cachedSource(item, storageDir)
  if (cached && !opts.force && (await canReuse(cached, item))) {
    return cached
  }
  // `force` skips the cache; `respectBackoff` (admin refetch) also keeps the
  // backoff, which a plain force otherwise bypasses.
  if (
    (opts.respectBackoff || (!cached && !opts.force)) &&
    (await inBackoff(item.acquisitionBackoff))
  ) {
    return {
      acquired: false,
      reason: 'all_tiers_failed',
      reasons: item.acquisitionBackoff.reasons || [],
      backoff: true,
      retryAt: new Date(item.acquisitionBackoff.retryAt).toISOString(),
    }
  }

  const attemptedAt = new Date()
  const detailed = await withDetail(item)
  const { result, reasons, transient } = await runTiers(detailed, cfg, {
    ...opts,
    storageDir,
  })

  if (!result) {
    if (transient) {
      logWarn('acquisition_transient_failure', { token: item.token, reasons })
      if (cached) return servedCached(cached, opts)
      return {
        acquired: false,
        reason: 'upstream_busy',
        reasons,
        transient: true,
      }
    }
    // keep serving the previous zip; the failed upgrade is backed off too
    await recordFailure(item, attemptedAt, reasons, Boolean(cached))
    if (cached) return servedCached(cached, opts)
    logWarn('acquisition_exhausted', { token: item.token, reasons })
    return { acquired: false, reason: 'all_tiers_failed', reasons }
  }

  await persist(detailed, result, attemptedAt)
  logInfo('source_acquired', {
    token: item.token,
    tier: result.tier,
    zipSha256: result.zipSha256,
  })
  return {
    acquired: true,
    cached: false,
    tier: result.tier,
    zipSha256: result.zipSha256,
    mainFile: result.mainFile || null,
    hasMissingDependencies: Boolean(result.hasMissingDependencies),
    missingFiles: result.missingFiles || [],
    item: detailed,
  }
}

/**
 * True while an acquisition for this item is running in this process.
 *
 * @param {object} item
 * @returns {boolean}
 */
export function isAcquiring(item) {
  return Boolean(item) && inflight.has(String(item.token || item._id))
}

/**
 * Resolve the project zip for an item, single-flight per item in-process.
 *
 * @param {object} item - templateGalleryItems document
 * @param {{ cfg?: object, storageDir?: string, force?: boolean, respectBackoff?: boolean }} [opts]
 * @returns {Promise<{ acquired: boolean, cached?: boolean, tier?: number, zipSha256?: string, mainFile?: string|null, hasMissingDependencies?: boolean, missingFiles?: string[], item?: object, reason?: string, reasons?: string[], backoff?: boolean, retryAt?: string }>}
 */
export function acquire(item, opts = {}) {
  if (!item || typeof item !== 'object') {
    return Promise.resolve({ acquired: false, reason: 'invalid_argument' })
  }
  const key = String(item.token || item._id)
  // force skips the cache, never the single-flight: a run already in flight is
  // joined, not replaced
  if (inflight.has(key)) return inflight.get(key)

  const pending = acquireUncached(item, opts).finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key)
  })
  inflight.set(key, pending)
  return pending
}

export default {
  acquire,
  isAcquiring,
}
