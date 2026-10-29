import mongodb from 'mongodb'
import { itemsCol } from '../persistence/Collections.mjs'
import Audit from '../persistence/Audit.mjs'
import LicenceService from './LicenceService.mjs'
import ImageMapper from './ImageMapper.mjs'
import PublishGate from './PublishGate.mjs'
import {
  ADMIN_OVERRIDABLE_FIELDS,
  normalizeTags,
} from './TemplateCrawlerService.mjs'
import { generateToken } from '../persistence/Migrations.mjs'
import { isValidToken } from '../util/GalleryUrls.mjs'

const { ObjectId } = mongodb

// Item fields an admin may edit. Editing a crawler-owned field records
// `adminOverrides.<field> = true` so later catalogue runs leave it alone.
const EDITABLE_FIELDS = [
  'title',
  'author',
  'description',
  'tags',
  'featured',
  'official',
  'brand',
  'brandVariation',
  'licenseLabel',
  'templateName',
  'mainFile',
  'latexEngine',
  'texImage',
  'compile',
  'openParams',
  'license',
]
const OVERRIDE_TRACKED_FIELDS = new Set([
  ...ADMIN_OVERRIDABLE_FIELDS,
  'licenseLabel',
  'templateName',
  'mainFile',
  'latexEngine',
  'texImage',
])

/**
 * Normalizes an id into a filter: Mongo _id, 12-letter token, or Algolia
 * objectID.
 *
 * @param {string | mongodb.ObjectId} id
 * @returns {object}
 */
export function toIdFilter(id) {
  if (id instanceof ObjectId) {
    return { _id: id }
  }
  const value = String(id ?? '').trim()
  if (/^[a-f0-9]{24}$/i.test(value)) {
    return { _id: new ObjectId(value) }
  }
  if (isValidToken(value)) {
    return { token: value }
  }
  return { objectID: value }
}

/**
 * Fields every admin-created item starts with: a random 12-letter token (the
 * shape of official tokens), no Algolia id, family "template".
 */
export function newAdminItemFields() {
  return {
    token: generateToken(),
    objectID: null,
    objectIDNum: null,
    family: 'template',
    source: 'upload',
  }
}

export { generateToken }

/**
 * Retrieves an item by its 12-letter token.
 *
 * @param {string} token
 * @returns {Promise<object | null>}
 */
export async function getByToken(token) {
  if (!isValidToken(token)) return null
  const col = await itemsCol()
  return col.findOne({ token })
}

/**
 * Legacy slug lookup (old /templates/t/:slug links). Slugs are not unique, so
 * this returns the most recent published match.
 *
 * @param {string} slug
 * @returns {Promise<object | null>}
 */
export async function getBySlug(slug) {
  if (!slug || typeof slug !== 'string') return null
  const col = await itemsCol()
  return col.findOne(
    { slug: slug.trim() },
    { sort: { state: 1, recentOrder: -1, objectIDNum: -1 } }
  )
}

/**
 * Retrieves an item by Mongo _id, token or Algolia objectID.
 *
 * @param {string | mongodb.ObjectId} id
 * @returns {Promise<object | null>}
 */
export async function getById(id) {
  if (!id) return null
  const col = await itemsCol()
  return col.findOne(toIdFilter(id))
}

/**
 * Retrieves an item by Algolia objectID.
 *
 * @param {string | number} objectID
 * @returns {Promise<object | null>}
 */
export async function getByObjectID(objectID) {
  if (!objectID) return null
  const col = await itemsCol()
  return col.findOne({ objectID: String(objectID) })
}

function normalizeTagPatch(tags) {
  if (!Array.isArray(tags)) return []
  return normalizeTags(
    tags.map(tag =>
      typeof tag === 'string'
        ? { name: slugifyTag(tag), title: tag.trim() }
        : { name: tag?.name || slugifyTag(tag?.title), title: tag?.title }
    )
  )
}

function slugifyTag(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Updates editable metadata on a template item.
 *
 * @param {string | mongodb.ObjectId} id
 * @param {object} patch - Fields to update
 * @param {string} [adminUserId]
 * @returns {Promise<object>}
 */
export async function updateMetadata(id, patch = {}, adminUserId = null) {
  const col = await itemsCol()
  const filter = toIdFilter(id)
  const existing = await col.findOne(filter)
  if (!existing) {
    const err = new Error(`Template item not found for id: ${id}`)
    err.code = 'not_found'
    throw err
  }

  const update = {
    $inc: { revision: 1 },
    $set: { updatedAt: new Date() },
  }

  for (const key of EDITABLE_FIELDS) {
    if (patch[key] === undefined) continue
    update.$set[key] = key === 'tags' ? normalizeTagPatch(patch[key]) : patch[key]
    if (OVERRIDE_TRACKED_FIELDS.has(key)) {
      update.$set[`adminOverrides.${key}`] = true
    }
  }

  // Hand fields back to the crawler: { releaseOverrides: ['title', ...] }
  if (Array.isArray(patch.releaseOverrides)) {
    for (const key of patch.releaseOverrides) {
      if (OVERRIDE_TRACKED_FIELDS.has(key) && update.$set[key] === undefined) {
        update.$unset = { ...update.$unset, [`adminOverrides.${key}`]: '' }
      }
    }
  }

  // If license was modified, recalculate license hash
  if (patch.license) {
    const mergedLicence = { ...existing.license, ...patch.license }
    if (!mergedLicence.code && mergedLicence.declared) {
      mergedLicence.code = LicenceService.suggestCodeFromLabel(mergedLicence.declared)
    }
    const licenceHash = LicenceService.computeLicenceHash({
      declared: mergedLicence.declared,
      code: mergedLicence.code,
      detected: mergedLicence.detected,
      detectedSha256: mergedLicence.detectedSha256,
      conflict: mergedLicence.conflict,
    })
    update.$set.license = { ...mergedLicence, licenceHash }
  }

  // If compiler parameters modified, update compile hash
  if (patch.compile) {
    const mergedCompile = { ...existing.compile, ...patch.compile }
    const hash = ImageMapper.computeCompileHash({
      imageName: mergedCompile.imageName || mergedCompile.texImage,
      compiler: mergedCompile.compiler,
      mainFile: mergedCompile.mainFile,
    })
    mergedCompile.compileHash = hash
    update.$set.compile = mergedCompile
  }

  const res = await col.findOneAndUpdate({ _id: existing._id }, update, {
    returnDocument: 'after',
  })

  await Audit.record('update_metadata', {
    itemId: String(existing._id),
    userId: adminUserId,
    detail: `Updated metadata: ${Object.keys(patch).join(', ')}`,
  })

  return res.value || res
}

/**
 * Acknowledges a license conflict or non-standard license by administrator.
 *
 * @param {string | mongodb.ObjectId} id
 * @param {string} note - Admin rationale note (min length enforced by cfg)
 * @param {string} adminUserId
 * @param {object} [cfg] - Template gallery config
 * @returns {Promise<object>}
 */
export async function acknowledgeLicence(id, note, adminUserId, cfg = {}) {
  const minNoteChars = Number(cfg?.licence?.ackMinNoteChars) || 20
  const cleanNote = String(note || '').trim()

  if (cleanNote.length < minNoteChars) {
    const err = new Error(`Acknowledgement note must be at least ${minNoteChars} characters`)
    err.code = 'note_too_short'
    throw err
  }

  if (!adminUserId) {
    const err = new Error('Admin user ID is required to acknowledge license')
    err.code = 'unauthorized'
    throw err
  }

  const col = await itemsCol()
  const filter = toIdFilter(id)
  const item = await col.findOne(filter)
  if (!item) {
    const err = new Error(`Template item not found for id: ${id}`)
    err.code = 'not_found'
    throw err
  }

  const declared = item.license?.declared || ''
  const code = item.license?.code || LicenceService.suggestCodeFromLabel(declared)
  const detected = item.license?.detected || null
  const detectedSha256 = item.license?.detectedSha256 || null
  const conflict = Boolean(detected && detected !== code)

  const licenceHash = LicenceService.computeLicenceHash({
    declared,
    code,
    detected,
    detectedSha256,
    conflict,
  })

  const ack = {
    by: String(adminUserId),
    at: new Date(),
    note: cleanNote,
    hash: licenceHash,
  }

  const update = {
    $inc: { revision: 1 },
    $set: {
      'license.ack': ack,
      'license.conflict': conflict,
      'license.code': code,
      updatedAt: new Date(),
    },
  }

  const res = await col.findOneAndUpdate(filter, update, { returnDocument: 'after' })

  await Audit.record('acknowledge_licence', {
    itemId: String(item._id),
    userId: adminUserId,
    detail: `Acknowledged license (${code}): ${cleanNote.slice(0, 100)}`,
  })

  return res.value || res
}

/**
 * Publishes a template item to the public gallery after passing all PublishGate checks.
 *
 * @param {string | mongodb.ObjectId} id
 * @param {string} adminUserId
 * @param {object} [cfg] - Template gallery config
 * @param {object} [runtime] - Runtime status (allowedImages, sandboxEnforced, etc.)
 * @returns {Promise<object>}
 */
export async function publish(id, adminUserId, cfg = {}, runtime = {}) {
  const col = await itemsCol()
  const filter = toIdFilter(id)
  const item = await col.findOne(filter)
  if (!item) {
    const err = new Error(`Template item not found for id: ${id}`)
    err.code = 'not_found'
    throw err
  }

  const gateResult = PublishGate.evaluate(item, cfg, runtime)
  if (!gateResult.ok) {
    const err = new Error('Template failed publish gate criteria')
    err.code = 'gate_failed'
    err.unmet = gateResult.unmet
    throw err
  }

  const update = {
    $inc: { revision: 1 },
    $set: {
      state: 'published',
      publishedAt: new Date(),
      publishedBy: adminUserId ? String(adminUserId) : null,
      updatedAt: new Date(),
    },
  }

  const res = await col.findOneAndUpdate(filter, update, { returnDocument: 'after' })

  await Audit.record('publish_item', {
    itemId: String(item._id),
    userId: adminUserId,
    detail: `Published template ${item.slug}`,
  })

  return res.value || res
}

/**
 * Unpublishes an item, hiding it from the public gallery.
 *
 * @param {string | mongodb.ObjectId} id
 * @param {string} [adminUserId]
 * @returns {Promise<object>}
 */
export async function unpublish(id, adminUserId = null) {
  const col = await itemsCol()
  const filter = toIdFilter(id)
  const item = await col.findOne(filter)
  if (!item) {
    const err = new Error(`Template item not found for id: ${id}`)
    err.code = 'not_found'
    throw err
  }

  const update = {
    $inc: { revision: 1 },
    $set: {
      state: 'unpublished',
      unpublishedAt: new Date(),
      unpublishedBy: adminUserId ? String(adminUserId) : null,
      updatedAt: new Date(),
    },
  }

  const res = await col.findOneAndUpdate(filter, update, { returnDocument: 'after' })

  await Audit.record('unpublish_item', {
    itemId: String(item._id),
    userId: adminUserId,
    detail: `Unpublished template ${item.slug}`,
  })

  return res.value || res
}

/**
 * Archives a template item.
 *
 * @param {string | mongodb.ObjectId} id
 * @param {string} [adminUserId]
 * @returns {Promise<object>}
 */
export async function archive(id, adminUserId = null) {
  const col = await itemsCol()
  const filter = toIdFilter(id)
  const item = await col.findOne(filter)
  if (!item) {
    const err = new Error(`Template item not found for id: ${id}`)
    err.code = 'not_found'
    throw err
  }

  const update = {
    $inc: { revision: 1 },
    $set: {
      state: 'archived',
      archivedAt: new Date(),
      archivedBy: adminUserId ? String(adminUserId) : null,
      updatedAt: new Date(),
    },
  }

  const res = await col.findOneAndUpdate(filter, update, { returnDocument: 'after' })

  await Audit.record('archive_item', {
    itemId: String(item._id),
    userId: adminUserId,
    detail: `Archived template ${item.slug}`,
  })

  return res.value || res
}

/**
 * Permanently deletes a draft, unvalidated, or archived template item.
 * Requires confirming the slug to prevent accidental deletion.
 * Published items cannot be deleted directly (must be unpublished/archived first).
 *
 * @param {string | mongodb.ObjectId} id
 * @param {string} confirmSlug
 * @param {string} [adminUserId]
 * @returns {Promise<{ ok: boolean, deletedId: string }>}
 */
export async function deleteItem(id, confirmSlug, adminUserId = null) {
  const col = await itemsCol()
  const filter = toIdFilter(id)
  const item = await col.findOne(filter)
  if (!item) {
    const err = new Error(`Template item not found for id: ${id}`)
    err.code = 'not_found'
    throw err
  }

  if (item.slug !== confirmSlug) {
    const err = new Error(`Confirmation slug '${confirmSlug}' does not match '${item.slug}'`)
    err.code = 'slug_mismatch'
    throw err
  }

  if (item.state === 'published') {
    const err = new Error('Cannot delete published template; unpublish or archive first')
    err.code = 'published_cannot_delete'
    throw err
  }

  await col.deleteOne(filter)

  await Audit.record('delete_item', {
    itemId: String(item._id),
    userId: adminUserId,
    detail: `Deleted item ${item.slug} (${item.objectID})`,
  })

  return {
    ok: true,
    deletedId: String(item._id),
  }
}

export default {
  toIdFilter,
  newAdminItemFields,
  generateToken,
  getByToken,
  getBySlug,
  getById,
  getByObjectID,
  updateMetadata,
  acknowledgeLicence,
  publish,
  unpublish,
  archive,
  deleteItem,
}
