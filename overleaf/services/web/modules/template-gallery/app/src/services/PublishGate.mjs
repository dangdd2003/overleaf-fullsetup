import LicenceService from './LicenceService.mjs'
import ImageMapper from './ImageMapper.mjs'

/**
 * Pure evaluator for template item publishing readiness.
 * Checks all preconditions and returns list of unmet criteria.
 *
 * @param {object} item - Document from templateGalleryItems
 * @param {object} [cfg] - Template gallery settings (Settings.templateGallery)
 * @param {object} [runtime] - Runtime environment status (sandboxEnforced, allowedImages, etc.)
 * @returns {{ ok: boolean, unmet: Array<{ code: string, text: string }> }}
 */
export function evaluate(item = {}, cfg = {}, runtime = {}) {
  const unmet = []

  // 1. State check: must be in ready or already published (or draft that meets criteria)
  // When publishing, states like 'draft', 'ready', 'unpublished' can transition to published
  if (['archived', 'blob_missing'].includes(item.state)) {
    unmet.push({
      code: 'state_invalid',
      text: `Item state '${item.state}' cannot be published`,
    })
  }

  // 2. Metadata checks
  if (!item.title || typeof item.title !== 'string' || !item.title.trim()) {
    unmet.push({
      code: 'missing_title',
      text: 'Template must have a non-empty title',
    })
  }

  if (!item.author || typeof item.author !== 'string' || !item.author.trim()) {
    unmet.push({
      code: 'missing_author',
      text: 'Template must have an author declared',
    })
  }

  // 3. Licence checks
  const declaredLicence = item.license?.declared
  if (!declaredLicence || typeof declaredLicence !== 'string' || !declaredLicence.trim()) {
    unmet.push({
      code: 'licence_missing',
      text: 'Licence declared string must be present',
    })
  }

  const licenceEval = LicenceService.evaluateLicence(item.license, cfg?.licence)

  if (item.license?.code === 'unknown' || (!item.license?.code && licenceEval.isBlocked)) {
    // If unknown licence code
    if (item.license?.code === 'unknown' || LicenceService.suggestCodeFromLabel(declaredLicence) === 'unknown') {
      unmet.push({
        code: 'licence_unknown',
        text: 'Unknown licence cannot be published without counsel review',
      })
    }
  }

  if (licenceEval.isBlocked) {
    unmet.push({
      code: 'licence_blocked',
      text: `Licence '${item.license?.code || 'unknown'}' is blocked by policy`,
    })
  }

  if (licenceEval.requiresAck && !licenceEval.ackValid) {
    unmet.push({
      code: 'licence_ack',
      text: 'Licence requires administrative acknowledgement before publication',
    })
  }

  // 4. Source checks: sourceAcquired must be true, or sourcePackageHash / zip.sha256 present
  const hasSource = Boolean(
    item.sourceAcquired ||
    item.sourcePackageHash ||
    item.sourceBlobStoreKey ||
    item.zip?.sha256
  )

  if (!hasSource) {
    unmet.push({
      code: 'source_missing',
      text: 'Source package archive has not been acquired into BlobStore',
    })
  }

  // 5. Validation check
  const requireValidation = Boolean(
    cfg?.publish?.requireValidation ?? cfg?.validation?.requireValidationForPublish ?? true
  )

  if (requireValidation) {
    if (item.validation?.status !== 'passed') {
      unmet.push({
        code: 'validation_unmet',
        text: `Validation status must be 'passed' (current: '${item.validation?.status || 'none'}')`,
      })
    }
  }

  // 6. Image check: Docker image resolution
  const imageCandidate = item.compile?.imageName || item.compile?.texImage || item.openParams?.texImage
  const imgRes = ImageMapper.resolveImage(
    { imageBasename: item.compile?.imageBasename, texImage: imageCandidate },
    cfg,
    runtime.allowedImages
  )
  if (!imgRes.ok) {
    unmet.push({
      code: 'image_unavailable',
      text: imgRes.reason || 'TeX compilation image is unavailable or unlisted in deployment',
    })
  }

  // 7. Brand check
  if (item.brand && cfg?.brands?.blocked?.includes(item.brand)) {
    unmet.push({
      code: 'brand_blocked',
      text: `Brand '${item.brand}' is blocked in this deployment`,
    })
  }

  // 8. Sandbox check: if validation required sandboxing and instance enforces sandbox
  const sandboxEnforced = runtime.sandboxEnforced ?? cfg?.validation?.sandboxEnforced ?? false
  if (sandboxEnforced && item.validation?.sandboxMode === 'unsandboxed') {
    if (!cfg?.validation?.allowUnsandboxedAck) {
      unmet.push({
        code: 'sandbox_unmet',
        text: 'Sandboxed compilation is enforced but template was validated unsandboxed',
      })
    }
  }

  return {
    ok: unmet.length === 0,
    unmet,
  }
}

export default {
  evaluate,
}
