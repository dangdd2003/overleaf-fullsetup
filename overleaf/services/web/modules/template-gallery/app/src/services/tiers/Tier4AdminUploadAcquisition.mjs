import crypto from 'node:crypto'
import mongodb from 'mongodb'
import { inspect } from '../../zip/ZipInspector.mjs'
import LicenceService from '../LicenceService.mjs'
import ImageMapper from '../ImageMapper.mjs'
import BlobStore from '../../storage/BlobStore.mjs'
import { itemsCol } from '../../persistence/Collections.mjs'
import Audit from '../../persistence/Audit.mjs'
import { isValidToken } from '../../util/GalleryUrls.mjs'
import { pickMainFile, resolveLimits, resolveStorageDir } from './TierSupport.mjs'
import { logInfo } from '../../observability/Log.mjs'

const { ObjectId } = mongodb

// Tier 4: an admin uploads the full project zip ("bring your own zip"), either
// for a new gallery item or to give an existing (crawled) item its real
// multi-file source.

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

export function generateToken() {
  let token = ''
  for (let i = 0; i < 12; i++) {
    token += TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)]
  }
  return token
}

function itemFilter(ref) {
  const value = String(ref)
  if (/^[a-f0-9]{24}$/i.test(value)) return { _id: new ObjectId(value) }
  if (isValidToken(value)) return { token: value }
  if (/^\d+$/.test(value)) return { objectID: value }
  return null
}

function notFound(ref) {
  const err = new Error(`Template item not found: ${ref}`)
  err.code = 'item_not_found'
  return err
}

/**
 * Build a conflict-free upsert: every path is written by exactly one operator
 * (MongoDB rejects `$set`/`$setOnInsert`/`$inc` touching the same path, or a
 * path and its parent, with ConflictingUpdateOperators).
 *
 * @param {object} set - fields always written
 * @param {object} insertDefaults - fields written only when inserting
 * @param {object} [inc]
 */
export function buildUpsertUpdate(set, insertDefaults, inc = {}) {
  const owned = [...Object.keys(set), ...Object.keys(inc)]
  const conflicts = key =>
    owned.some(
      path => path === key || path.startsWith(`${key}.`) || key.startsWith(`${path}.`)
    )
  const setOnInsert = Object.fromEntries(
    Object.entries(insertDefaults).filter(([key]) => !conflicts(key))
  )
  const update = { $set: set }
  if (Object.keys(setOnInsert).length > 0) update.$setOnInsert = setOnInsert
  if (Object.keys(inc).length > 0) update.$inc = inc
  return update
}

/**
 * @param {string} zipFilePath - uploaded archive (moved into the BlobStore)
 * @param {object} [meta] - { itemId? (_id, token or objectID), token? (for a new item), slug, title, author, description, tags, licence, licenceLabel, mainFile, compiler|latexEngine, texImage, family, state, featured, official }
 * @param {string|null} [adminUserId]
 * @param {object} [cfg] - Settings.templateGallery
 * @param {{ storageDir?: string }} [opts]
 */
export async function ingestAdminZip(zipFilePath, meta = {}, adminUserId = null, cfg = {}, opts = {}) {
  const storageDir = resolveStorageDir(cfg, opts.storageDir)
  const inspection = await inspect(zipFilePath, resolveLimits(cfg))

  const col = await itemsCol()
  // With an item reference the upload replaces that item's source; without
  // one it creates (or re-uploads) an admin item keyed by slug.
  const ref = meta.itemId
  const filter = ref ? itemFilter(ref) : null
  const replacing = Boolean(ref || meta.replaceExisting)
  if (
    replacing &&
    (!filter || !(await col.findOne(filter, { projection: { _id: 1 } })))
  ) {
    throw notFound(ref)
  }

  // Moves the upload into the BlobStore; the caller's cleanup then no-ops
  const committed = await BlobStore.commitFile(zipFilePath, { storageDir })
  const zipSha256 = committed.sha256
  const now = new Date()

  const mainFile = pickMainFile(inspection.texCandidates, meta.mainFile) || 'main.tex'
  const engine = meta.latexEngine || meta.compiler || null
  const { compiler, compilerSource } = ImageMapper.resolveCompiler(engine)
  const image = ImageMapper.resolveImage({ texImage: meta.texImage || meta.imageName }, cfg)

  const set = {
    sourceAcquired: true,
    sourceBlobStoreKey: zipSha256,
    acquisitionTier: 4,
    hasMissingDependencies: false,
    missingFiles: [],
    zip: {
      sha256: zipSha256,
      sizeBytes: committed.sizeBytes,
      entryCount: inspection.entryCount,
      uncompressedBytes: inspection.totalUncompressedBytes,
      mainFile,
      tier: 4,
      acquiredAt: now,
      attemptedAt: now,
    },
    compile: {
      mainFile,
      compiler,
      compilerSource,
      imageName: image.imageName,
      imageBasename: image.imageBasename,
    },
    updatedAt: now,
    updatedBy: adminUserId,
  }

  // Explicit admin metadata wins and is protected from the crawler.
  const explicit = {
    title: meta.title,
    author: meta.author,
    description: meta.description,
    tags: Array.isArray(meta.tags) ? meta.tags : undefined,
    mainFile: meta.mainFile ? mainFile : undefined,
    latexEngine: engine || undefined,
    texImage: meta.texImage || undefined,
  }
  for (const [field, value] of Object.entries(explicit)) {
    if (value === undefined) continue
    set[field] = value
    set[`adminOverrides.${field}`] = true
  }

  const detectedCode = inspection.licence?.text
    ? LicenceService.detectFromText(inspection.licence.text)
    : null
  if (meta.licence || meta.licenceLabel || detectedCode) {
    const code =
      meta.licence ||
      detectedCode ||
      LicenceService.suggestCodeFromLabel(meta.licenceLabel)
    set.license = {
      code,
      declared: meta.licenceLabel || code,
      declaredLabel: meta.licenceLabel || code,
      source: detectedCode && !meta.licence ? 'detected-archive' : 'admin-input',
    }
    set.licenseLabel = set.license.declaredLabel
  }

  const slug = meta.slug || `custom-template-${zipSha256.slice(0, 12)}`
  const insertDefaults = {
    token: isValidToken(meta.token) ? meta.token : generateToken(),
    objectID: null,
    objectIDNum: null,
    family: ['template', 'example', 'article'].includes(meta.family) ? meta.family : 'template',
    slug,
    title: 'Custom Template',
    author: 'Administrator',
    description: '',
    tags: [],
    featured: Boolean(meta.featured),
    official: meta.official === true ? true : null,
    mainFile,
    latexEngine: null,
    texImage: null,
    license: { code: 'unknown', declared: null, declaredLabel: null, source: 'admin-input' },
    licenseLabel: null,
    state: meta.state || 'draft',
    source: 'upload',
    stats: { opens: 0, lastOpenedAt: null },
    createdAt: now,
  }

  const update = buildUpsertUpdate(set, insertDefaults, { revision: 1 })
  const res = await col.findOneAndUpdate(filter || { slug, source: 'upload' }, update, {
    upsert: !replacing,
    returnDocument: 'after',
  })
  const savedItem = res?.value !== undefined ? res.value : res
  if (!savedItem) throw notFound(ref)

  if (adminUserId) {
    // best-effort, never throws
    await Audit.record('TEMPLATE_ADMIN_ZIP_INGEST', {
      itemId: savedItem._id,
      userId: adminUserId,
      detail: `zip ${zipSha256} (${committed.sizeBytes} bytes)`,
    })
  }

  logInfo('admin_zip_ingested', { token: savedItem.token, zipSha256 })
  return { ok: true, item: savedItem, zipSha256, inspection }
}

export default {
  generateToken,
  buildUpsertUpdate,
  ingestAdminZip,
}
