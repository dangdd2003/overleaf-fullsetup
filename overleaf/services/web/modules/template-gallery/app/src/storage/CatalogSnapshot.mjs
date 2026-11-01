// @ts-check
// overleaf/services/web/modules/template-gallery/app/src/storage/CatalogSnapshot.mjs
//
// Volume snapshot of the rebuildable templateGallery* collections (SNAPSHOT_COLLECTIONS).
//
//   S/store.json                     store identity, created once, never rewritten
//   S/catalog/current.json           atomic pointer {format, generation, dir}
//   S/catalog/gen-<generation>/      manifest.json + <collection>.jsonl.gz per collection
//   S/catalog/.tmp-<uuid>/           in-progress export, swept after an hour
//
// Readers trust only current.json. Each collection file holds one canonical EJSON document
// per line, gzipped. Export and import stream; no whole collection is held in memory.

import crypto, { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { BSON } from 'mongodb'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'
import {
  SNAPSHOT_COLLECTIONS,
  collectionByName,
} from '../persistence/Collections.mjs'
import { blobRefsOf } from './BlobRefs.mjs'
import { logWarn } from '../observability/Log.mjs'

/**
 * @typedef {{file: string, count: number, bytes: number, sha256: string}} SnapshotFileInfo
 * @typedef {{format: 1, storeId: string, generation: string, createdAt: string, reason: string, collections: Record<string, SnapshotFileInfo>}} SnapshotManifest
 */

const FORMAT = 1
const ITEMS_COLLECTION = 'templateGalleryItems'
const KEEP_GENERATIONS = 3
const INSERT_BATCH_SIZE = 500
const STALE_TMP_MS = 60 * 60_000
const DUPLICATE_KEY_CODE = 11000
const GENERATION_RE = /^\d{8}T\d{9}-[0-9a-f]{6}$/
const SHA256_RE = /^[0-9a-f]{64}$/

/** Refuse to publish a partially restored database, including forced exports. */
export async function assertRestoreComplete() {
  const config = await collectionByName('templateGalleryConfig')
  const marker = await config.findOne({ _id: 'store' })
  if (marker?.restoreState === 'in_progress') {
    throw coded(
      'SNAPSHOT_RESTORE_INCOMPLETE',
      'catalog snapshot restore is incomplete'
    )
  }
}

let lastGenerationMs = 0

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function coded(code, message) {
  return Object.assign(new Error(message), { code })
}

/** @param {unknown} err */
function errorCode(err) {
  if (err && typeof err === 'object' && 'code' in err) {
    return err.code
  }
  return undefined
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

/** @param {unknown} err */
function isNotFound(err) {
  const code = errorCode(err)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** @param {unknown} err */
function isZlibError(err) {
  const code = errorCode(err)
  return typeof code === 'string' && code.startsWith('Z_')
}

/**
 * @param {any} value
 * @returns {any[]}
 */
function toArray(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * @param {string} [storageDir]
 * @returns {string}
 */
function resolveStorageDir(storageDir) {
  if (storageDir && typeof storageDir === 'string') {
    return storageDir
  }
  return DEFAULTS.storageDir
}

/**
 * UTC `YYYYMMDDTHHMMSSmmm` plus 6 random hex chars. Strictly increasing within a process,
 * so lexicographic order matches export order.
 *
 * @param {number} [nowMs]
 * @returns {string}
 */
function newGeneration(nowMs = Date.now()) {
  lastGenerationMs = Math.max(nowMs, lastGenerationMs + 1)
  const stamp = new Date(lastGenerationMs).toISOString().replace(/[-:.Z]/g, '')
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`
}

/** @param {string} dir */
function catalogDirOf(dir) {
  return path.join(dir, 'catalog')
}

/** @param {string} dir */
function pointerPathOf(dir) {
  return path.join(catalogDirOf(dir), 'current.json')
}

/**
 * @param {string} dir
 * @param {string} generation
 * @returns {string}
 */
function generationDirOf(dir, generation) {
  if (!GENERATION_RE.test(generation)) {
    throw coded(
      'SNAPSHOT_INVALID',
      `invalid snapshot generation: ${generation}`
    )
  }
  return path.join(catalogDirOf(dir), `gen-${generation}`)
}

// fsync errors that mean "this filesystem cannot fsync", not an I/O failure. They are logged and
// skipped, so an export never fails because the volume does not support fsync.
const FSYNC_UNSUPPORTED_CODES = new Set([
  'ENOTSUP',
  'EOPNOTSUPP',
  'EINVAL',
  'ENOSYS',
  'EPERM',
])

/**
 * Flushes a file or directory to disk. Uses the callback API: FileHandle.sync() is not
 * implemented by the Yarn PnP fs patch (see BlobStore.mjs).
 *
 * @param {string} target
 * @param {string} [flags]
 * @returns {Promise<void>}
 */
function fsyncPath(target, flags = 'r') {
  return new Promise((resolve, reject) => {
    fs.open(target, flags, (openErr, fd) => {
      if (openErr) return reject(openErr)
      fs.fsync(fd, (syncErr) => {
        fs.close(fd, (closeErr) => {
          if (closeErr) return reject(closeErr)
          if (
            syncErr &&
            !FSYNC_UNSUPPORTED_CODES.has(String(errorCode(syncErr)))
          ) {
            return reject(syncErr)
          }
          if (syncErr) {
            logWarn('fsync_unsupported', {
              target,
              error: errorMessage(syncErr),
            })
          }
          resolve()
        })
      })
    })
  })
}

/**
 * Best-effort ownership fix when running as root (e.g. CLI docker exec).
 * Chowns target to storageDir's uid and gid.
 *
 * @param {string} storageDir
 * @param {string} target
 */
async function maybeFixOwnership(storageDir, target) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
  try {
    const st = await fs.promises.stat(storageDir)
    await fs.promises.chown(target, st.uid, st.gid)
  } catch {
    // best-effort
  }
}

/**
 * Writes a new file (must not exist yet) and flushes it to disk.
 *
 * @param {string} file
 * @param {string} content
 * @param {string} [storageDir]
 */
async function writeFileSynced(file, content, storageDir) {
  await fs.promises.writeFile(file, content, { flag: 'wx', mode: 0o640 })
  await fsyncPath(file)
  if (storageDir) {
    await maybeFixOwnership(storageDir, file)
  }
}

/** @param {string} dir */
function fsyncDir(dir) {
  return fsyncPath(dir)
}

/**
 * @param {string} file
 * @returns {Promise<{sha256: string, bytes: number}>}
 */
async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  let bytes = 0
  for await (const chunk of fs.createReadStream(file)) {
    const buf = /** @type {Buffer} */ (chunk)
    hash.update(buf)
    bytes += buf.length
  }
  return { sha256: hash.digest('hex'), bytes }
}

/**
 * Counts the documents (newline-terminated lines) of a gzipped collection file.
 *
 * @param {string} file
 * @returns {Promise<number>}
 */
async function countDocLines(file) {
  const source = fs.createReadStream(file)
  const gunzip = zlib.createGunzip()
  // Errors surface through the iterator below; this only keeps the pipeline promise handled.
  pipeline(source, gunzip).catch(() => {})
  let lines = 0
  try {
    for await (const chunk of gunzip) {
      const buf = /** @type {Buffer} */ (chunk)
      let idx = buf.indexOf(0x0a)
      while (idx !== -1) {
        lines++
        idx = buf.indexOf(0x0a, idx + 1)
      }
    }
  } finally {
    gunzip.destroy()
    source.destroy()
  }
  return lines
}

/**
 * Streams one collection file: file -> gunzip -> readline -> EJSON.parse.
 *
 * @param {string} genDir
 * @param {SnapshotFileInfo} info
 * @returns {AsyncGenerator<any>}
 */
async function* iterateCollectionFile(genDir, info) {
  const source = fs.createReadStream(path.join(genDir, info.file))
  const gunzip = zlib.createGunzip()
  const lines = readline.createInterface({
    input: gunzip,
    crlfDelay: Infinity,
  })
  /** @type {unknown} */
  let streamError = null
  pipeline(source, gunzip).catch((err) => {
    streamError = err
    lines.close()
  })
  try {
    for await (const line of lines) {
      if (line.length > 0) {
        yield BSON.EJSON.parse(line, { relaxed: false })
      }
    }
    if (streamError) {
      throw streamError
    }
  } finally {
    lines.close()
    source.destroy()
  }
}

/**
 * Writes <tmpDir>/<name>.jsonl.gz: cursor -> canonical EJSON line -> gzip -> file.
 *
 * @param {string} name
 * @param {string} tmpDir
 * @param {() => boolean} [isAborted] checked per document so a timed-out export stops reading
 * @returns {Promise<SnapshotFileInfo>}
 */
async function writeCollectionFile(name, tmpDir, isAborted) {
  const col = await collectionByName(name)
  const file = `${name}.jsonl.gz`
  const target = path.join(tmpDir, file)
  let count = 0

  async function* lines() {
    for await (const doc of col.find({})) {
      if (isAborted?.()) {
        throw coded('SNAPSHOT_EXPORT_ABORTED', 'snapshot export aborted')
      }
      count++
      yield `${BSON.EJSON.stringify(doc, { relaxed: false })}\n`
    }
  }

  await pipeline(
    Readable.from(lines()),
    zlib.createGzip(),
    fs.createWriteStream(target, { flags: 'wx', mode: 0o640 })
  )
  await fsyncPath(target)
  const { sha256, bytes } = await hashFile(target)
  return { file, count, bytes, sha256 }
}

/**
 * Replaces current.json. The rename is the publish point: failures before it leave the
 * previous generation as the current one.
 *
 * @param {string} dir
 * @param {{format: 1, generation: string, dir: string}} pointer
 */
async function replacePointer(dir, pointer) {
  const target = pointerPathOf(dir)
  const tmp = `${target}.tmp-${randomUUID()}`
  try {
    await writeFileSynced(tmp, `${JSON.stringify(pointer)}\n`, dir)
    await fs.promises.rename(tmp, target)
    await maybeFixOwnership(dir, target)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  // The pointer already names the new generation. A failed directory fsync only weakens durability.
  await fsyncDir(catalogDirOf(dir)).catch((err) => {
    logWarn('catalog_fsync_failed', { error: errorMessage(err) })
  })
}

/**
 * Removes generation directories beyond the newest KEEP_GENERATIONS. The current one and
 * whichever generation is currently referenced by current.json are always kept.
 *
 * @param {string} dir
 * @param {string} currentGeneration
 */
async function pruneGenerations(dir, currentGeneration) {
  try {
    const pointer = await readJsonOrNull(pointerPathOf(dir))
    const pointerGen = pointer?.generation
    const entries = await fs.promises.readdir(catalogDirOf(dir), {
      withFileTypes: true,
    })
    const generations = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('gen-'))
      .map((entry) => entry.name.slice('gen-'.length))
      .filter((generation) => GENERATION_RE.test(generation))
      .sort()
      .reverse()
    const keep = new Set([
      currentGeneration,
      ...(pointerGen ? [pointerGen] : []),
      ...generations.slice(0, KEEP_GENERATIONS),
    ])
    for (const generation of generations) {
      if (!keep.has(generation)) {
        await fs.promises.rm(generationDirOf(dir, generation), {
          recursive: true,
          force: true,
        })
      }
    }
  } catch (err) {
    logWarn('catalog_prune_failed', { error: errorMessage(err) })
  }
}

/**
 * Removes abandoned .tmp-* entries (failed exports, interrupted pointer swaps) older than an hour.
 *
 * @param {string} catalog
 */
async function sweepStaleTmp(catalog) {
  try {
    const names = await fs.promises.readdir(catalog)
    const now = Date.now()
    for (const name of names) {
      if (!name.includes('.tmp-')) continue
      const full = path.join(catalog, name)
      const stat = await fs.promises.stat(full)
      if (now - stat.mtimeMs > STALE_TMP_MS) {
        await fs.promises.rm(full, { recursive: true, force: true })
      }
    }
  } catch (err) {
    logWarn('catalog_tmp_sweep_failed', { error: errorMessage(err) })
  }
}

/**
 * Refuses to replace a snapshot that holds items with one whose Items collection is empty or shrunk.
 *
 * @param {SnapshotManifest | null} previous
 * @param {SnapshotFileInfo} itemsInfo
 * @param {{force?: boolean, reason?: string}} [opts]
 */
function assertItemsNotShrunk(previous, itemsInfo, opts = {}) {
  const previousCount = previous?.collections?.[ITEMS_COLLECTION]?.count ?? 0
  if (itemsInfo.count === 0 && previousCount > 0) {
    throw coded(
      'SNAPSHOT_EMPTY_REFUSED',
      `refusing to replace a snapshot holding ${previousCount} items with an empty one`
    )
  }
  const isForced =
    opts.force === true || opts.reason === 'cli' || opts.reason === 'manual'
  if (!isForced && previousCount > 0 && itemsInfo.count < previousCount * 0.5) {
    throw coded(
      'SNAPSHOT_SHRINK_REFUSED',
      `refusing to replace a snapshot holding ${previousCount} items with one holding ${itemsInfo.count} (< 50%)`
    )
  }
}

/**
 * @param {unknown} value
 * @param {string} expectedGeneration
 * @returns {value is SnapshotManifest}
 */
function isValidManifest(value, expectedGeneration) {
  if (!value || typeof value !== 'object') return false
  const manifest = /** @type {any} */ (value)
  if (manifest.format !== FORMAT || manifest.generation !== expectedGeneration)
    return false
  if (
    typeof manifest.storeId !== 'string' ||
    typeof manifest.createdAt !== 'string' ||
    typeof manifest.reason !== 'string'
  ) {
    return false
  }
  if (!manifest.collections || typeof manifest.collections !== 'object')
    return false
  return SNAPSHOT_COLLECTIONS.every((name) =>
    isValidFileInfo(name, manifest.collections[name])
  )
}

/**
 * @param {string} name
 * @param {any} info
 * @returns {boolean}
 */
function isValidFileInfo(name, info) {
  return (
    Boolean(info) &&
    info.file === `${name}.jsonl.gz` &&
    Number.isSafeInteger(info.count) &&
    info.count >= 0 &&
    Number.isSafeInteger(info.bytes) &&
    info.bytes >= 0 &&
    typeof info.sha256 === 'string' &&
    SHA256_RE.test(info.sha256)
  )
}

/**
 * @param {any} pointer
 * @returns {boolean}
 */
function isValidPointer(pointer) {
  return (
    Boolean(pointer) &&
    pointer.format === FORMAT &&
    typeof pointer.generation === 'string' &&
    GENERATION_RE.test(pointer.generation) &&
    pointer.dir === `gen-${pointer.generation}`
  )
}

/**
 * Reads a JSON file. Returns null when it is missing or not valid JSON.
 *
 * @param {string} file
 * @returns {Promise<any>}
 */
async function readJsonOrNull(file) {
  let raw
  try {
    raw = await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Creates S/store.json once and returns its identity. An existing file is never rewritten.
 * Creation links a fully written temp file into place, so a crash never leaves a partial file.
 *
 * @param {string} [storageDir]
 * @returns {Promise<{storeId: string, createdAt: string}>}
 */
export async function ensureStoreIdentity(storageDir) {
  const dir = resolveStorageDir(storageDir)
  const catalog = catalogDirOf(dir)
  await fs.promises.mkdir(catalog, { recursive: true, mode: 0o750 })
  await maybeFixOwnership(dir, catalog)
  const existing = await readStoreIdentity(dir)
  if (existing) return existing

  const identity = {
    format: FORMAT,
    storeId: randomUUID(),
    createdAt: new Date().toISOString(),
  }
  const file = path.join(dir, 'store.json')
  /** @type {fs.promises.FileHandle | null} */
  let handle = null
  try {
    handle = await fs.promises.open(file, 'wx', 0o640)
    await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`)
    const fd = handle.fd
    await new Promise((resolve) => {
      fs.fsync(fd, (syncErr) => {
        if (
          syncErr &&
          !FSYNC_UNSUPPORTED_CODES.has(String(errorCode(syncErr)))
        ) {
          logWarn('fsync_unsupported', {
            target: file,
            error: errorMessage(syncErr),
          })
        }
        resolve(undefined)
      })
    })
    await handle.close()
    handle = null
    await maybeFixOwnership(dir, file)
    await fsyncDir(dir).catch(() => {})
    return { storeId: identity.storeId, createdAt: identity.createdAt }
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {})
    }
    if (errorCode(err) !== 'EEXIST') throw err
  }

  const winner = await readStoreIdentity(dir)
  if (!winner) {
    throw new Error(`store identity missing after create: ${file}`)
  }
  return winner
}

/**
 * @param {string} dir
 * @returns {Promise<{storeId: string, createdAt: string} | null>}
 */
async function readStoreIdentity(dir) {
  let raw
  try {
    raw = await fs.promises.readFile(path.join(dir, 'store.json'), 'utf8')
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
  const parsed = JSON.parse(raw)
  if (
    parsed?.format !== FORMAT ||
    typeof parsed.storeId !== 'string' ||
    typeof parsed.createdAt !== 'string'
  ) {
    throw coded(
      'STORE_IDENTITY_INVALID',
      `invalid store identity file: ${path.join(dir, 'store.json')}`
    )
  }
  return { storeId: parsed.storeId, createdAt: parsed.createdAt }
}

/**
 * Writes a new generation of every snapshot collection, then flips current.json.
 * Readers keep the previous generation until the pointer swap. Keeps the 3 newest generations.
 *
 * @param {{storageDir?: string, reason?: string, force?: boolean, checkLease?: () => Promise<boolean>, isAborted?: () => boolean}} [opts]
 * @returns {Promise<SnapshotManifest>}
 */
export async function exportSnapshot(opts = {}) {
  await assertRestoreComplete()
  const dir = resolveStorageDir(opts.storageDir)
  const reason = opts.reason || 'manual'
  const identity = await ensureStoreIdentity(dir)
  const catalog = catalogDirOf(dir)
  await sweepStaleTmp(catalog)
  const previous = await readCurrentManifest(dir)

  const generation = newGeneration()
  const finalDir = generationDirOf(dir, generation)
  const tmpDir = path.join(catalog, `.tmp-${randomUUID()}`)
  await fs.promises.mkdir(tmpDir, { mode: 0o750 })
  await maybeFixOwnership(dir, tmpDir)

  let renamed = false
  let published = false
  try {
    /** @type {Record<string, SnapshotFileInfo>} */
    const collections = {}
    for (const name of SNAPSHOT_COLLECTIONS) {
      collections[name] = await writeCollectionFile(
        name,
        tmpDir,
        opts.isAborted
      )
      if (name === ITEMS_COLLECTION) {
        assertItemsNotShrunk(previous, collections[name], opts)
      }
    }
    /** @type {SnapshotManifest} */
    const manifest = {
      format: FORMAT,
      storeId: identity.storeId,
      generation,
      createdAt: new Date().toISOString(),
      reason,
      collections,
    }
    await writeFileSynced(
      path.join(tmpDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      dir
    )
    await fsyncDir(tmpDir)
    await fs.promises.rename(tmpDir, finalDir)
    renamed = true
    await maybeFixOwnership(dir, finalDir)
    await fsyncDir(catalog)

    if (typeof opts.checkLease === 'function') {
      const leaseValid = await opts.checkLease()
      if (!leaseValid) {
        throw coded(
          'SNAPSHOT_LEASE_LOST',
          'snapshot export lease lost before pointer swap'
        )
      }
    }

    await assertRestoreComplete()
    await replacePointer(dir, {
      format: FORMAT,
      generation,
      dir: `gen-${generation}`,
    })
    published = true
    await pruneGenerations(dir, generation)
    return manifest
  } catch (err) {
    await fs.promises
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {})
    if (renamed && !published) {
      await fs.promises
        .rm(finalDir, { recursive: true, force: true })
        .catch(() => {})
    }
    throw err
  }
}

/**
 * Scans retained gen-* directories newest-to-oldest, returning all generation names.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listRetainedGenerations(dir) {
  try {
    const entries = await fs.promises.readdir(catalogDirOf(dir), {
      withFileTypes: true,
    })
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('gen-'))
      .map((entry) => entry.name.slice('gen-'.length))
      .filter((generation) => GENERATION_RE.test(generation))
      .sort()
      .reverse()
  } catch (err) {
    if (isNotFound(err)) return []
    throw err
  }
}

/**
 * Checks all collection files of a generation against its manifest.
 *
 * @param {string} dir
 * @param {SnapshotManifest} manifest
 */
async function verifyGeneration(dir, manifest) {
  const genDir = generationDirOf(dir, manifest.generation)
  for (const name of SNAPSHOT_COLLECTIONS) {
    await verifyCollectionFile(genDir, name, manifest.collections[name])
  }
}

/**
 * Checks if any generation directories exist in the catalog directory.
 *
 * @param {string} [storageDir]
 * @returns {Promise<boolean>}
 */
export async function hasSnapshotGenerations(storageDir) {
  const dir = resolveStorageDir(storageDir)
  const gens = await listRetainedGenerations(dir)
  return gens.length > 0
}

/**
 * Reads the snapshot that current.json points to. If missing or invalid, falls back to
 * the newest valid retained generation. Returns null when there is no valid snapshot.
 *
 * @param {string} [storageDir]
 * @returns {Promise<SnapshotManifest|null>}
 */
export async function readCurrentManifest(storageDir) {
  const dir = resolveStorageDir(storageDir)
  const pointer = await readJsonOrNull(pointerPathOf(dir))
  if (isValidPointer(pointer)) {
    const manifest = await readJsonOrNull(
      path.join(generationDirOf(dir, pointer.generation), 'manifest.json')
    )
    if (isValidManifest(manifest, pointer.generation)) {
      return manifest
    }
  }

  // Fallback: scan retained gen-* newest to oldest
  const generations = await listRetainedGenerations(dir)
  for (const generation of generations) {
    if (pointer && generation === pointer.generation) continue
    const manifest = await readJsonOrNull(
      path.join(generationDirOf(dir, generation), 'manifest.json')
    )
    if (isValidManifest(manifest, generation)) {
      return manifest
    }
  }
  return null
}

/**
 * Checks every collection file of a generation against the manifest (size, sha256 and document
 * count) before anything is imported. Throws code SNAPSHOT_CORRUPT on a mismatch or unreadable data.
 *
 * @param {string} genDir
 * @param {string} name
 * @param {SnapshotFileInfo} info
 */
async function verifyCollectionFile(genDir, name, info) {
  const file = path.join(genDir, info.file)
  try {
    const actual = await hashFile(file)
    if (actual.bytes !== info.bytes || actual.sha256 !== info.sha256) {
      throw coded('SNAPSHOT_CORRUPT', `${name}: checksum mismatch`)
    }
    const lines = await countDocLines(file)
    if (lines !== info.count) {
      throw coded(
        'SNAPSHOT_CORRUPT',
        `${name}: manifest says ${info.count} documents, file has ${lines}`
      )
    }
  } catch (err) {
    if (errorCode(err) === 'SNAPSHOT_CORRUPT') throw err
    if (errorCode(err) === 'ENOENT' || isZlibError(err)) {
      throw coded('SNAPSHOT_CORRUPT', `${name}: ${errorMessage(err)}`)
    }
    throw err
  }
}

/**
 * insertMany(ordered:false). Duplicate-key errors mean the document is already present, so a
 * re-run is idempotent. Any other write error is rethrown.
 *
 * @param {any} col
 * @param {any[]} docs
 * @returns {Promise<number>} newly inserted documents
 */
async function insertBatch(col, docs) {
  try {
    const res = await col.insertMany(docs, { ordered: false })
    return Number(res?.insertedCount ?? docs.length)
  } catch (err) {
    const bulkError = /** @type {any} */ (err)
    const result = bulkError?.result
    const raw = result?.getRawResponse?.() || result?.result || result
    const writeErrors = toArray(bulkError?.writeErrors)
    const resultErrors = toArray(result?.getWriteErrors?.() || raw?.writeErrors)
    // Duplicate entries can accompany an unacknowledged/uncertain write.
    // Such a result must retain the durable progress marker for recovery.
    if (
      bulkError?.err ||
      bulkError?.writeConcernError ||
      bulkError?.writeConcernErrors?.length ||
      result?.getWriteConcernError?.() ||
      raw?.writeConcernError ||
      raw?.writeConcernErrors?.length ||
      (errorCode(err) != null && errorCode(err) !== DUPLICATE_KEY_CODE) ||
      writeErrors.length + resultErrors.length === 0 ||
      ![...writeErrors, ...resultErrors].every(
        (e) => errorCode(e) === DUPLICATE_KEY_CODE
      )
    ) {
      throw err
    }
    const insertedCount = result?.insertedCount
    return Number(
      insertedCount ?? docs.length - (writeErrors.length || resultErrors.length)
    )
  }
}

/**
 * @param {string} genDir
 * @param {string} name
 * @param {SnapshotFileInfo} info
 * @param {(() => Promise<boolean>) | undefined} checkLease
 * @returns {Promise<number>} newly inserted documents
 */
async function importCollection(genDir, name, info, checkLease) {
  const col = await collectionByName(name)
  /** @type {any[]} */
  let batch = []
  let read = 0
  let inserted = 0
  for await (const doc of iterateCollectionFile(genDir, info)) {
    batch.push(doc)
    read++
    if (batch.length === INSERT_BATCH_SIZE) {
      await assertImportLease(checkLease)
      inserted += await insertBatch(col, batch)
      batch = []
    }
  }
  if (batch.length > 0) {
    await assertImportLease(checkLease)
    inserted += await insertBatch(col, batch)
  }
  if (read !== info.count) {
    throw new Error(
      `${name}: read ${read} documents, manifest says ${info.count}`
    )
  }
  return inserted
}

/** @param {(() => Promise<boolean>) | undefined} checkLease */
async function assertImportLease(checkLease) {
  if (checkLease && !(await checkLease())) {
    throw coded('SNAPSHOT_LEASE_LOST', 'snapshot restore lease lost')
  }
}

/**
 * Loads the current (or newest valid fallback) snapshot into the collections. Every file is
 * verified before anything is inserted. Items is loaded last so that if an import is interrupted,
 * the restoreState marker tracks the in_progress status and can resume.
 * Duplicate-key errors are tolerated, so a re-run is safe.
 *
 * @param {{storageDir?: string, expectedSnapshot?: {storeId: string, generation: string}, checkLease?: () => Promise<boolean>, beforeImport?: (manifest: SnapshotManifest) => Promise<void>}} [opts]
 * @returns {Promise<{generation: string, counts: Record<string, number>}>} counts = newly inserted documents per collection
 */
export async function importSnapshot(opts = {}) {
  const dir = resolveStorageDir(opts.storageDir)
  const pointer = await readJsonOrNull(pointerPathOf(dir))
  /** @type {string[]} */
  const candidateGenerations = []
  if (opts.expectedSnapshot) {
    if (!GENERATION_RE.test(opts.expectedSnapshot.generation)) {
      throw coded(
        'SNAPSHOT_RESTORE_MISMATCH',
        'invalid interrupted snapshot generation'
      )
    }
    candidateGenerations.push(opts.expectedSnapshot.generation)
  } else if (isValidPointer(pointer)) {
    candidateGenerations.push(pointer.generation)
  }
  const allGens = opts.expectedSnapshot
    ? []
    : await listRetainedGenerations(dir)
  for (const gen of allGens) {
    if (!candidateGenerations.includes(gen)) {
      candidateGenerations.push(gen)
    }
  }

  if (candidateGenerations.length === 0) {
    throw coded('SNAPSHOT_MISSING', 'no valid catalog snapshot to import')
  }

  /** @type {SnapshotManifest | null} */
  let chosenManifest = null
  for (const gen of candidateGenerations) {
    const manifest = await readJsonOrNull(
      path.join(generationDirOf(dir, gen), 'manifest.json')
    )
    if (!isValidManifest(manifest, gen)) continue
    if (
      opts.expectedSnapshot &&
      manifest.storeId !== opts.expectedSnapshot.storeId
    ) {
      throw coded(
        'SNAPSHOT_RESTORE_MISMATCH',
        'snapshot store identity changed during restore'
      )
    }
    try {
      await verifyGeneration(dir, manifest)
      chosenManifest = manifest
      break
    } catch (err) {
      logWarn('snapshot_gen_verification_failed', {
        generation: gen,
        error: errorMessage(err),
      })
    }
  }

  if (!chosenManifest) {
    throw coded(
      opts.expectedSnapshot ? 'SNAPSHOT_RESTORE_MISMATCH' : 'SNAPSHOT_CORRUPT',
      'no valid catalog snapshot to import (all candidates corrupt)'
    )
  }

  await opts.beforeImport?.(chosenManifest)
  await assertImportLease(opts.checkLease)
  const genDir = generationDirOf(dir, chosenManifest.generation)
  /** @type {Record<string, number>} */
  const counts = {}
  const order = [
    ...SNAPSHOT_COLLECTIONS.filter((name) => name !== ITEMS_COLLECTION),
    ITEMS_COLLECTION,
  ]
  for (const name of order) {
    await assertImportLease(opts.checkLease)
    counts[name] = await importCollection(
      genDir,
      name,
      chosenManifest.collections[name],
      opts.checkLease
    )
  }
  return { generation: chosenManifest.generation, counts }
}

/**
 * Streams the documents of one collection from the current snapshot. Yields nothing when there is none.
 *
 * @param {string} collectionName
 * @param {string} [storageDir]
 * @returns {AsyncGenerator<any>}
 */
export async function* iterateSnapshotDocs(collectionName, storageDir) {
  if (!SNAPSHOT_COLLECTIONS.some((name) => name === collectionName)) {
    throw coded(
      'SNAPSHOT_UNKNOWN_COLLECTION',
      `not a snapshot collection: ${collectionName}`
    )
  }
  const dir = resolveStorageDir(storageDir)
  const manifest = await readCurrentManifest(dir)
  if (!manifest) return
  yield* iterateCollectionFile(
    generationDirOf(dir, manifest.generation),
    manifest.collections[collectionName]
  )
}

/**
 * Every blob sha256 referenced by items in ALL retained valid generations (not only current.json),
 * so older generations also protect their blobs in GC. Empty when there is no snapshot.
 *
 * @param {string} [storageDir]
 * @returns {Promise<Set<string>>}
 */
export async function snapshotBlobRefs(storageDir) {
  const dir = resolveStorageDir(storageDir)
  const shas = new Set()
  const generations = await listRetainedGenerations(dir)
  for (const generation of generations) {
    const genDir = generationDirOf(dir, generation)
    const manifest = await readJsonOrNull(path.join(genDir, 'manifest.json'))
    if (!isValidManifest(manifest, generation)) continue
    const itemsInfo = manifest.collections[ITEMS_COLLECTION]
    if (!itemsInfo) continue
    try {
      for await (const doc of iterateCollectionFile(genDir, itemsInfo)) {
        for (const ref of blobRefsOf(doc)) {
          shas.add(ref.sha)
        }
      }
    } catch (err) {
      logWarn('snapshot_blob_refs_gen_failed', {
        generation,
        error: errorMessage(err),
      })
    }
  }
  return shas
}

export default {
  ensureStoreIdentity,
  exportSnapshot,
  readCurrentManifest,
  hasSnapshotGenerations,
  importSnapshot,
  iterateSnapshotDocs,
  snapshotBlobRefs,
}
