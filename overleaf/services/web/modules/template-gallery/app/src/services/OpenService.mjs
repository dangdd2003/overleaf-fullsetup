import fsp from 'node:fs/promises'
import Path from 'node:path'
import Settings from '@overleaf/settings'
import ProjectUploadManager from '../../../../../app/src/Features/Uploads/ProjectUploadManager.mjs'
import ProjectRootDocManager from '../../../../../app/src/Features/Project/ProjectRootDocManager.mjs'
import ProjectDetailsHandler from '../../../../../app/src/Features/Project/ProjectDetailsHandler.mjs'
import { InvalidZipFileError } from '../../../../../app/src/Features/Uploads/ArchiveErrors.mjs'
import { DEFAULTS } from '../TemplateGalleryDefaults.mjs'
import { itemsCol } from '../persistence/Collections.mjs'
import BlobStore from '../storage/BlobStore.mjs'
import { scratchPath } from '../storage/Paths.mjs'
import { isValidToken } from '../util/GalleryUrls.mjs'
import TemplateSourceAcquisitionService from './TemplateSourceAcquisitionService.mjs'
import ImageMapper from './ImageMapper.mjs'
import { resolveStorageDir } from './tiers/TierSupport.mjs'
import { logInfo, logWarn } from '../observability/Log.mjs'

// "Open as Template": create a project on this instance from a gallery item,
// the way CE's TemplatesManager.createProjectFromV1Template does for v1
// templates (unique name from the template title, compiler from latexEngine,
// image from texImage, root doc from mainFile, never a brandVariationId).

function codedError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * Lookup an item that the requesting user may open. Only published items are
 * public; site admins (allowUnpublished) may open any state.
 *
 * @param {string} token
 * @param {{ allowUnpublished?: boolean }} [opts]
 * @returns {Promise<object|null>}
 */
export async function findOpenableItem(token, { allowUnpublished = false } = {}) {
  if (!token || typeof token !== 'string') return null
  const col = await itemsCol()
  if (isValidToken(token)) {
    const filter = allowUnpublished ? { token } : { token, state: 'published' }
    return col.findOne(filter)
  }
  const baseFilter = { $or: [{ token }, { slug: token }, { objectID: token }] }
  const filter = allowUnpublished
    ? baseFilter
    : { $and: [baseFilter, { state: 'published' }] }
  return col.findOne(filter)
}

function projectAttributes(item) {
  const { compiler } = ImageMapper.resolveCompiler(
    item.latexEngine || item.compile?.compiler || item.openParams?.latexEngine
  )
  const { imageName } = ImageMapper.resolveImage(
    { texImage: item.texImage || item.compile?.imageBasename || item.openParams?.texImage },
    Settings.templateGallery
  )
  const attributes = { compiler }
  if (imageName) attributes.imageName = imageName
  return attributes
}

async function setMainFile(projectId, mainFile) {
  if (!mainFile) return
  try {
    await ProjectRootDocManager.promises.setRootDocFromName(projectId, mainFile)
  } catch (err) {
    // the upload already picked a root doc automatically
    logWarn('set_root_doc_failed', { projectId, mainFile, err: err.message })
  }
}

async function recordOpen(item) {
  try {
    const col = await itemsCol()
    await col.updateOne(
      { _id: item._id },
      { $inc: { 'stats.opens': 1 }, $set: { 'stats.lastOpenedAt': new Date() } }
    )
  } catch (err) {
    logWarn('stats_increment_failed', { token: item.token, err: err.message })
  }
}

/**
 * @param {string} token - gallery item token ([a-z]{12})
 * @param {string} userId - owner of the new project
 * @param {{ cfg?: object, storageDir?: string, allowUnpublished?: boolean, forceAcquire?: boolean }} [opts]
 * @returns {Promise<{ projectId: string, acquisitionTier: number, hasMissingDependencies: boolean }>}
 */
export async function openTemplate(token, userId, opts = {}) {
  if (!userId) throw new Error('userId is required to open a template')

  const item = await findOpenableItem(token, {
    allowUnpublished: opts.allowUnpublished,
  })
  if (!item) throw codedError('item_not_found', `no openable item ${token}`)

  const cfg = opts.cfg || Settings.templateGallery || DEFAULTS
  const storageDir = resolveStorageDir(cfg, opts.storageDir)

  const source = await TemplateSourceAcquisitionService.acquire(item, {
    cfg,
    storageDir,
    force: Boolean(opts.forceAcquire),
  })
  if (!source.acquired) {
    const err = codedError('source_acquisition_failed', `no source for ${token}`)
    err.reasons = source.reasons
    throw err
  }
  const sourceItem = source.item || item

  const zipPath = scratchPath(storageDir, undefined, '.zip')
  await fsp.mkdir(Path.dirname(zipPath), { recursive: true, mode: 0o750 })
  try {
    try {
      await BlobStore.copyVerified(source.zipSha256, zipPath, storageDir)
    } catch (err) {
      throw codedError('bundle_unavailable', `source blob unusable: ${err.code || err.message}`)
    }

    const projectName = ProjectDetailsHandler.fixProjectName(
      sourceItem.title || sourceItem.templateName || sourceItem.slug || 'Template'
    )
    let project
    try {
      ;({ project } =
        await ProjectUploadManager.promises.createProjectFromZipArchiveWithName(
          userId,
          projectName,
          zipPath,
          projectAttributes(sourceItem)
        ))
    } catch (err) {
      if (err instanceof InvalidZipFileError) {
        throw codedError('bundle_invalid', `source zip rejected: ${err.message}`)
      }
      throw err
    }

    await setMainFile(
      project._id,
      source.mainFile || sourceItem.mainFile || sourceItem.openParams?.mainFile
    )
    await recordOpen(item)

    logInfo('template_opened', {
      token,
      userId: String(userId),
      projectId: String(project._id),
      tier: source.tier,
    })
    return {
      projectId: String(project._id),
      acquisitionTier: source.tier,
      hasMissingDependencies: Boolean(source.hasMissingDependencies),
    }
  } finally {
    await fsp.rm(zipPath, { force: true })
  }
}

export default {
  findOpenableItem,
  openTemplate,
}
