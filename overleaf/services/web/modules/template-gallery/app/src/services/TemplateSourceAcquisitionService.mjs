import { itemsCol, configCol } from '../persistence/Collections.mjs'
import BlobStore from '../storage/BlobStore.mjs'
import SessionCredentialStore from '../crypto/SessionCredentialStore.mjs'
import { ensureDetail } from './mirror/MirrorService.mjs'
import { acquireViaCloudSession } from './tiers/Tier1SessionAcquisition.mjs'
import { acquireViaGitArchive } from './tiers/Tier2GitAcquisition.mjs'
import { acquireViaSynthesis, sourceTextSha } from './tiers/Tier3SynthesisAcquisition.mjs'
import { resolveStorageDir } from './tiers/TierSupport.mjs'
import { logInfo, logWarn } from '../observability/Log.mjs'

// Finds or builds the project zip for a gallery item:
//   cached zip -> Tier 1 (stored overleaf.com session) -> Tier 2 (linked git
//   repo) -> Tier 3 (single-file synthesis from the mirrored main .tex).
// Tier 4 (admin upload) only ever arrives through the cache.
//
// Tiers 1, 2 and 4 are full sources and are reused as long as the blob exists.
// A cached Tier 3 zip is reused too, but rebuilt when the mirrored main file
// changed, and Tier 1 is retried once whenever an admin stores a (new)
// session cookie after the zip was built.

const FULL_SOURCE_TIERS = new Set([1, 2, 4])

const inflight = new Map()

function tierEnabled(cfg, tier) {
  return cfg?.sourceAcquisition?.[`tier${tier}Enabled`] !== false
}

async function cachedSource(item, storageDir) {
  const sha = item.sourceBlobStoreKey || item.zip?.sha256
  if (!sha || !(await BlobStore.exists(sha, storageDir))) return null
  return {
    acquired: true,
    cached: true,
    tier: item.acquisitionTier || item.zip?.tier || null,
    zipSha256: sha,
    mainFile: item.zip?.mainFile || item.mainFile || item.compile?.mainFile || null,
    hasMissingDependencies: Boolean(item.hasMissingDependencies),
    missingFiles: item.missingFiles || [],
  }
}

async function sessionStoredSince(since) {
  try {
    const state = await SessionCredentialStore.getSessionCredentialState(await configCol())
    if (!state) return false
    return !since || !state.updatedAt || new Date(state.updatedAt) > new Date(since)
  } catch (err) {
    logWarn('session_state_read_failed', { err: err.message })
    return false
  }
}

async function canReuse(cached, item, cfg) {
  if (FULL_SOURCE_TIERS.has(cached.tier)) return true
  if (cached.tier !== 3) return false
  if (item.zip?.sourceTextSha && item.mainText && item.zip.sourceTextSha !== sourceTextSha(item.mainText)) {
    return false
  }
  return !(tierEnabled(cfg, 1) && (await sessionStoredSince(item.zip?.attemptedAt)))
}

// Crawled items only carry Algolia data until their detail page is mirrored;
// the tiers need the CTA params (Tier 1) and the main file text (Tier 3).
async function withDetail(item) {
  if (item.source === 'upload' || !item.token) return item
  if (item.mainText && item.publishedId != null) return item
  try {
    return (await ensureDetail(item.token, { priority: 'interactive' })) || item
  } catch (err) {
    logWarn('ensure_detail_failed', { token: item.token, code: err?.code, err: err?.message })
    return item
  }
}

async function runTiers(item, cfg, opts) {
  const tiers = [
    [1, acquireViaCloudSession],
    [2, acquireViaGitArchive],
    [3, acquireViaSynthesis],
  ]
  const reasons = []
  for (const [tier, acquireFn] of tiers) {
    if (!tierEnabled(cfg, tier)) continue
    try {
      const result = await acquireFn(item, cfg, opts)
      if (result?.acquired) return { result, reasons }
      reasons.push(`tier${tier}:${result?.reason || 'unknown'}`)
    } catch (err) {
      logWarn('tier_attempt_failed', { token: item.token, tier, err: err?.message })
      reasons.push(`tier${tier}:error`)
    }
  }
  return { result: null, reasons }
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
        ...(result.gitRepoUrl ? { gitRepoUrl: result.gitRepoUrl } : {}),
      },
    }
  )
}

async function acquireUncached(item, opts) {
  const cfg = opts.cfg || {}
  const storageDir = resolveStorageDir(cfg, opts.storageDir)

  const cached = await cachedSource(item, storageDir)
  if (cached && !opts.force && (await canReuse(cached, item, cfg))) {
    return cached
  }

  const attemptedAt = new Date()
  const detailed = await withDetail(item)
  const { result, reasons } = await runTiers(detailed, cfg, {
    ...opts,
    storageDir,
  })

  if (!result) {
    // keep serving the previous zip, and do not retry the upgrade until the
    // stored session changes again
    if (cached) {
      const col = await itemsCol()
      await col.updateOne(
        { _id: item._id, zip: { $type: 'object' } },
        { $set: { 'zip.attemptedAt': attemptedAt } }
      )
      return cached
    }
    logWarn('acquisition_exhausted', { token: item.token, reasons })
    return { acquired: false, reason: 'all_tiers_failed', reasons }
  }

  await persist(detailed, result, attemptedAt)
  logInfo('source_acquired', { token: item.token, tier: result.tier, zipSha256: result.zipSha256 })
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
 * Resolve the project zip for an item, single-flight per item in-process.
 *
 * @param {object} item - templateGalleryItems document
 * @param {{ cfg?: object, storageDir?: string, force?: boolean, sessionCookie?: string }} [opts]
 * @returns {Promise<{ acquired: boolean, cached?: boolean, tier?: number, zipSha256?: string, mainFile?: string|null, hasMissingDependencies?: boolean, missingFiles?: string[], item?: object, reason?: string, reasons?: string[] }>}
 */
export function acquire(item, opts = {}) {
  if (!item || typeof item !== 'object') {
    return Promise.resolve({ acquired: false, reason: 'invalid_argument' })
  }
  const key = String(item.token || item._id)
  if (!opts.force && inflight.has(key)) return inflight.get(key)

  const pending = acquireUncached(item, opts).finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key)
  })
  inflight.set(key, pending)
  return pending
}

export default {
  acquire,
}
