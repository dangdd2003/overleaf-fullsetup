// overleaf/services/web/modules/template-gallery/app/src/storage/VolumeAudit.mjs
//
// Walks the whole storageDir, counts files and bytes per area, and removes what
// no reader can use: stray files under blobs/, storage probe markers, empty
// blob prefix directories and old scratch leftovers. Blobs whose content does
// not match their name are moved to quarantine/ by BlobStore.verify, the same
// semantics as IntegrityJob. Generation retention is handled by the caller
// (it needs the snapshot lease).
//
// Everything here is idempotent. Dry run reports the same numbers and changes nothing.

import fs from 'node:fs'
import path from 'node:path'
import { isValidSha256 } from './Paths.mjs'
import { areaOf, AREAS } from './StorageUsage.mjs'
import BlobStore from './BlobStore.mjs'
import { logWarn } from '../observability/Log.mjs'

export const PROBE_MAX_AGE_MS = 60 * 60_000
export const STRAY_MAX_AGE_MS = 60 * 60_000
export const TMP_FILE_MAX_AGE_MS = 60 * 60_000
// A scratch directory is only removed when nothing in it changed for this long
export const TMP_DIR_MAX_AGE_MS = 6 * 60 * 60_000
const DEFAULT_VERIFY_BUDGET_BYTES = 256 * 1024 * 1024

const zero = () => ({ files: 0, bytes: 0 })

/**
 * Lists every file and directory under storageDir with its area and size.
 * Entries that vanish during the walk are skipped.
 *
 * @returns {Promise<{ files: Array<{ rel: string, abs: string, area: string, size: number, mtimeMs: number }>, dirs: Array<{ rel: string, abs: string }> }>}
 */
export async function scanVolume(storageDir) {
  const files = []
  const dirs = []
  const walk = async dir => {
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(storageDir, abs)
      if (entry.isDirectory()) {
        dirs.push({ rel, abs })
        await walk(abs)
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(abs)
          files.push({
            rel,
            abs,
            area: areaOf(rel),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          })
        } catch {
          // removed while walking
        }
      }
    }
  }
  await walk(storageDir)
  return { files, dirs }
}

/**
 * Read-only audit: files and bytes per area, and per catalog generation.
 *
 * @returns {Promise<{ areas: Record<string, {files: number, bytes: number}>, total: {files: number, bytes: number}, generations: Array<{generation: string, files: number, bytes: number}> }>}
 */
export async function auditVolume(storageDir) {
  const { files } = await scanVolume(storageDir)
  const areas = Object.fromEntries(AREAS.map(area => [area, zero()]))
  const generations = new Map()
  const total = zero()
  for (const file of files) {
    areas[file.area].files++
    areas[file.area].bytes += file.size
    total.files++
    total.bytes += file.size
    const gen = /^catalog[\\/](gen-[^\\/]+)[\\/]/.exec(file.rel)
    if (gen) {
      const entry = generations.get(gen[1]) || { generation: gen[1].slice(4), files: 0, bytes: 0 }
      entry.files++
      entry.bytes += file.size
      generations.set(gen[1], entry)
    }
  }
  return {
    areas,
    total,
    generations: [...generations.values()].sort((a, b) => (a.generation < b.generation ? 1 : -1)),
  }
}

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * Newest mtime anywhere under a directory (bounded: stops reading once it is
 * newer than `olderThan`).
 */
async function newestMtime(dir) {
  let newest = 0
  const walk = async current => {
    let entries
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      try {
        const stat = await fs.promises.stat(abs)
        newest = Math.max(newest, stat.mtimeMs)
      } catch {
        continue
      }
      if (entry.isDirectory()) await walk(abs)
    }
  }
  await walk(dir)
  return newest
}

async function sizeTree(dir) {
  const out = zero()
  const walk = async current => {
    let entries
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        out.files++
        out.bytes += (await fs.promises.stat(abs).catch(() => ({ size: 0 }))).size
      }
    }
  }
  await walk(dir)
  return out
}

/**
 * Removes what no reader can use, or reports it in dry run.
 *
 * @param {string} storageDir
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {boolean} [opts.dryRun]
 * @param {number} [opts.verifyBudgetBytes] bytes of blobs to re-hash in this run (0 skips the check)
 * @param {string | null} [opts.verifyCursor] sha after which the check resumes
 * @param {number} [opts.yieldMs] pause between files (low IO priority)
 */
export async function cleanVolume(storageDir, opts = {}) {
  const now = opts.now ?? Date.now()
  const dryRun = opts.dryRun === true
  const yieldMs = opts.yieldMs ?? 0
  const freed = {
    probes: zero(),
    strays: zero(),
    emptyDirs: zero(),
    tmp: zero(),
    scratch: zero(),
  }

  // remove returns false in dry run, so counts are the same either way
  const remove = async (abs, bucket, size) => {
    bucket.files++
    bucket.bytes += size
    if (dryRun) return
    await fs.promises.rm(abs, { recursive: true, force: true }).catch(err => {
      logWarn('volume_audit_remove_failed', { path: path.basename(abs), error: err.message })
    })
  }

  const { files, dirs } = await scanVolume(storageDir)

  for (const file of files) {
    const age = now - file.mtimeMs
    if (file.area === 'probes' && age > PROBE_MAX_AGE_MS) {
      await remove(file.abs, freed.probes, file.size)
    } else if (file.area === 'strayBlobs' && age > STRAY_MAX_AGE_MS) {
      await remove(file.abs, freed.strays, file.size)
    } else if (file.area === 'tmp' && age > TMP_FILE_MAX_AGE_MS && path.dirname(file.rel) === 'tmp') {
      await remove(file.abs, freed.tmp, file.size)
    } else if (file.area === 'scratch' && age > TMP_FILE_MAX_AGE_MS && path.dirname(file.rel) === 'scratch') {
      await remove(file.abs, freed.scratch, file.size)
    }
    await sleep(yieldMs)
  }

  // Subdirectories of tmp/ and scratch/ left behind by a crashed job
  for (const root of ['tmp', 'scratch']) {
    const entries = await fs.promises.readdir(path.join(storageDir, root), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const abs = path.join(storageDir, root, entry.name)
      if (now - (await newestMtime(abs)) < TMP_DIR_MAX_AGE_MS) continue
      const size = await sizeTree(abs)
      freed[root === 'tmp' ? 'tmp' : 'scratch'].files += size.files
      freed[root === 'tmp' ? 'tmp' : 'scratch'].bytes += size.bytes
      if (!dryRun) await fs.promises.rm(abs, { recursive: true, force: true }).catch(() => {})
    }
  }

  // Empty prefix directories (and stray directories) under blobs/sha256
  const emptyCandidates = dirs
    .filter(dir => {
      const parts = dir.rel.split(path.sep)
      return parts[0] === 'blobs' && parts[1] === 'sha256' && parts.length === 3
    })
    .sort((a, b) => (a.rel < b.rel ? 1 : -1))
  for (const dir of emptyCandidates) {
    const entries = await fs.promises.readdir(dir.abs).catch(() => null)
    if (entries === null || entries.length > 0) continue
    // A blob write may have just created this directory and not renamed into it yet
    const stat = await fs.promises.stat(dir.abs).catch(() => null)
    if (!stat || now - stat.mtimeMs < STRAY_MAX_AGE_MS) continue
    freed.emptyDirs.files++
    if (!dryRun) await fs.promises.rmdir(dir.abs).catch(() => {})
  }

  // Re-hash blobs (budgeted, resumable). A checksum mismatch is quarantined by BlobStore.verify.
  const verify = { checked: 0, bytesChecked: 0, quarantined: 0, cursor: opts.verifyCursor ?? null, complete: false, skipped: null }
  const budget = opts.verifyBudgetBytes ?? DEFAULT_VERIFY_BUDGET_BYTES
  if (dryRun) {
    verify.skipped = 'dry_run'
  } else if (budget <= 0) {
    verify.skipped = 'disabled'
  } else {
    const blobs = files
      .filter(file => file.area === 'blobs' && isValidSha256(path.basename(file.abs)))
      .map(file => ({ sha: path.basename(file.abs), size: file.size }))
      .sort((a, b) => (a.sha < b.sha ? -1 : 1))
    let start = 0
    if (verify.cursor) {
      start = blobs.findIndex(blob => blob.sha > verify.cursor)
      if (start === -1) start = blobs.length
    }
    let i = start
    for (; i < blobs.length; i++) {
      if (verify.bytesChecked >= budget) break
      const blob = blobs[i]
      const res = await BlobStore.verify(blob.sha, storageDir).catch(() => null)
      verify.checked++
      verify.bytesChecked += blob.size
      verify.cursor = blob.sha
      if (res?.reason === 'corrupt') verify.quarantined++
      await sleep(yieldMs)
    }
    if (i >= blobs.length) {
      verify.complete = true
      verify.cursor = null
    }
  }

  const total = zero()
  for (const bucket of Object.values(freed)) {
    total.files += bucket.files
    total.bytes += bucket.bytes
  }
  return { dryRun, freed, total, verify }
}

export default {
  scanVolume,
  auditVolume,
  cleanVolume,
  PROBE_MAX_AGE_MS,
  STRAY_MAX_AGE_MS,
  TMP_FILE_MAX_AGE_MS,
  TMP_DIR_MAX_AGE_MS,
}
