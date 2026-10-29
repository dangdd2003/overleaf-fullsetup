import fs from 'node:fs'
import ProjectUploadManager from '../../../../../../app/src/Features/Uploads/ProjectUploadManager.mjs'
import ProjectRootDocManager from '../../../../../../app/src/Features/Project/ProjectRootDocManager.mjs'
import ProjectDeleter from '../../../../../../app/src/Features/Project/ProjectDeleter.mjs'
import { DeletedProjectReasons } from '../../../../../../app/src/Features/Project/DeletedProjectReasons.mjs'
import ProjectDetailsHandler from '../../../../../../app/src/Features/Project/ProjectDetailsHandler.mjs'
import CompileManager from '../../../../../../app/src/Features/Compile/CompileManager.mjs'
import ClsiManager from '../../../../../../app/src/Features/Compile/ClsiManager.mjs'
import { getOutputFileURL } from '../../../../../../app/src/Features/Compile/ClsiURLHelpers.mjs'
import { fetchStream, fetchString } from '@overleaf/fetch-utils'

import SandboxGate from '../../validation/SandboxGate.mjs'
import * as BlobStore from '../../storage/BlobStore.mjs'
import { scratchPath } from '../../storage/Paths.mjs'
import { itemsCol } from '../../persistence/Collections.mjs'
import JobStore from '../JobStore.mjs'
import Settings from '@overleaf/settings'
import { DEFAULTS } from '../../TemplateGalleryDefaults.mjs'
import * as ItemService from '../../services/ItemService.mjs'

/**
 * Validates a template item by setting up a staging project, compiling it,
 * capturing the output PDF & log into BlobStore, and updating item validation status.
 *
 * @param {object} job - Job document from templateGalleryJobs
 * @param {object} ctx - Execution context
 * @returns {Promise<any>}
 */
export async function run(job, ctx = {}) {
  const cfg = ctx.cfg || Settings.templateGallery || DEFAULTS
  const runtime = ctx.runtime || {}

  // 1. SandboxGate check
  const gate = SandboxGate.check(cfg, runtime)
  if (!gate.ok) {
    if (job?._id && ctx.runnerId && job.attempt !== undefined) {
      await JobStore.finish(job._id, ctx.runnerId, job.attempt, 'failed', {
        reason: 'sandbox-not-enforced',
        gate,
      })
    }
    return { ok: false, code: 'sandbox-not-enforced', gate }
  }

  // 2. Resolve target item
  const itemId = job.itemId || job?.payload?.itemId
  if (!itemId) {
    throw new Error('ValidationJob requires itemId')
  }

  const colItems = await itemsCol()
  const item = await ItemService.getById(itemId)
  if (!item) {
    throw new Error(`Item not found for id: ${itemId}`)
  }

  // 3. Find source zip sha256
  const sha = job.zipSha256Expected || item.zip?.sha256 || item.sourceBlobStoreKey || item.sourcePackageHash
  if (!sha) {
    throw new Error(`No source zip sha256 found for item: ${itemId}`)
  }

  const storageDir = cfg?.storageDir || DEFAULTS.storageDir
  const scratchFile = scratchPath(storageDir)

  let stagingProject = null

  try {
    // 4. Verify blob in store
    const verifyRes = await BlobStore.verify(sha, storageDir)
    if (!verifyRes.ok) {
      await colItems.updateOne(
        { _id: item._id },
        {
          $set: {
            state: 'blob_missing',
            'validation.status': 'failed',
            'validation.lastError': 'Blob verification failed',
            updatedAt: new Date(),
          },
        }
      )
      throw new Error(`Blob verification failed for sha ${sha}`)
    }

    // 5. Copy verified blob to scratchPath
    await BlobStore.copyVerified(sha, scratchFile, storageDir)

    // 6. Create staging project: "[Template check] ${item.title}"
    const projectName = `[Template check] ${item.title || item.slug || 'Untitled'}`
    const requestedBy = job.requestedBy || item.createdBy || Settings.adminUserId || '000000000000000000000000'

    stagingProject = await ProjectUploadManager.promises.createProjectFromZipArchiveWithName(
      requestedBy,
      projectName,
      scratchFile
    )

    const projectId = stagingProject._id

    // 7. Configure project compiler and imageName if specified on item
    if (item.compile?.compiler || item.compile?.imageName) {
      const updates = {}
      if (item.compile.compiler) updates.compiler = item.compile.compiler
      if (item.compile.imageName) updates.imageName = item.compile.imageName
      await ProjectDetailsHandler.promises.setProjectDescription(projectId, updates).catch(() => {})
    }

    // 8. Set root document
    if (item.compile?.mainFile) {
      await ProjectRootDocManager.promises.setRootDocFromName(projectId, item.compile.mainFile).catch(() => {})
    } else {
      await ProjectRootDocManager.promises.ensureRootDocumentIsValid(projectId).catch(() => {})
    }

    // 9. Run compilation via CompileManager
    const compileResult = await CompileManager.promises.compile(projectId, requestedBy, {})

    const compilePassed = compileResult.status === 'success'
    let logSha = null
    let pdfSha = null

    // 10. Fetch and store output files in BlobStore
    if (Array.isArray(compileResult.outputFiles)) {
      for (const outFile of compileResult.outputFiles) {
        if (!outFile.path) continue

        if (outFile.path === 'output.log' || outFile.path.endsWith('.log')) {
          try {
            const logUrl = getOutputFileURL(
              projectId,
              requestedBy,
              compileResult.buildId,
              outFile.path,
              compileResult.clsiServerId
            )
            const logStream = await fetchStream(logUrl.toString())
            const savedLog = await BlobStore.putStream(logStream, {
              storageDir,
              maxBytes: cfg?.limits?.maxLogBytes || 1024 * 1024,
            })
            logSha = savedLog.sha256
          } catch (_e) {
            // Log capture failure shouldn't fail compile evaluation
          }
        }

        if (outFile.path === 'output.pdf' || outFile.path.endsWith('.pdf')) {
          try {
            const pdfUrl = getOutputFileURL(
              projectId,
              requestedBy,
              compileResult.buildId,
              outFile.path,
              compileResult.clsiServerId
            )
            const pdfStream = await fetchStream(pdfUrl.toString())
            const savedPdf = await BlobStore.putStream(pdfStream, {
              storageDir,
              maxBytes: cfg?.limits?.maxPdfBytes || 50 * 1024 * 1024,
              magic: '%PDF-',
            })
            pdfSha = savedPdf.sha256
          } catch (_e) {
            // PDF capture failure
          }
        }
      }
    }

    const validationStatus = compilePassed ? 'passed' : 'failed'
    const newState = compilePassed ? 'ready' : 'validation_failed'

    const validationDoc = {
      status: validationStatus,
      validatedAt: new Date(),
      compileStatus: compileResult.status,
      buildId: compileResult.buildId || null,
      clsiServerId: compileResult.clsiServerId || null,
      sandboxMode: gate.mode || 'enforced',
      logSha,
      pdfSha,
      error: compilePassed ? null : (compileResult.message || compileResult.status),
    }

    // Update item validation & state
    await colItems.updateOne(
      { _id: item._id },
      {
        $set: {
          validation: validationDoc,
          state: newState,
          ...(pdfSha ? { 'pdf.sha256': pdfSha } : {}),
          updatedAt: new Date(),
        },
      }
    )

    // 11. Delete staging project on success with DeletedProjectReasons.SCRIPT
    if (compilePassed && stagingProject) {
      await ProjectDeleter.promises.deleteProject(projectId, {
        deletedReason: DeletedProjectReasons.SCRIPT,
      })
      stagingProject = null
    }

    return {
      ok: compilePassed,
      validation: validationDoc,
      state: newState,
    }
  } catch (err) {
    await colItems.updateOne(
      { _id: item._id },
      {
        $set: {
          state: 'validation_failed',
          'validation.status': 'failed',
          'validation.validatedAt': new Date(),
          'validation.error': err.message,
          updatedAt: new Date(),
        },
      }
    ).catch(() => {})

    throw err
  } finally {
    // 12. Cleanup scratchPath and any leftover staging project on error
    try {
      await fs.promises.unlink(scratchFile)
    } catch (_e) {
      // Ignore cleanup error if already removed or missing
    }

    if (stagingProject && stagingProject._id) {
      try {
        await ProjectDeleter.promises.deleteProject(stagingProject._id, {
          deletedReason: DeletedProjectReasons.SCRIPT,
        })
      } catch (_e) {
        // Ignore deletion error in finally
      }
    }
  }
}

export default {
  run,
}
