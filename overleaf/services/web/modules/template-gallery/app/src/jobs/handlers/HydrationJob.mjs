import { itemsCol } from '../../persistence/Collections.mjs'
import { isValidToken } from '../../util/GalleryUrls.mjs'
import * as MirrorService from '../../services/mirror/MirrorService.mjs'

/**
 * Background job: mirrors overleaf.com detail pages and PDFs.
 *
 * payload.token (or the legacy job.itemId) targets one item: its detail is
 * refreshed (`force` to bypass freshness/backoff) and its PDF fetched unless
 * `pdf: false`. Without a target the job trickles one detail batch and one
 * PDF batch. Per-item attempts and backoff live on the item (mirror.*).
 *
 * @param {object} job - Job document from templateGalleryJobs
 * @returns {Promise<object>}
 */
export async function run(job) {
  const payload = job?.payload || {}
  const token = await resolveToken(payload.token || job?.token, job?.itemId || payload.itemId)

  if (token) {
    const item = await MirrorService.ensureDetail(token, {
      force: Boolean(payload.force),
      throwOnError: true,
    })
    const pdf =
      item && payload.pdf !== false
        ? await MirrorService.ensurePdf(token, { force: Boolean(payload.force), throwOnError: true })
        : null
    return {
      ok: true,
      token,
      detail: Boolean(item?.mirror?.detailAt),
      removed: Boolean(item?.mirror?.removedAt) || item === null,
      pdf: Boolean(pdf),
    }
  }

  const detail = await MirrorService.runDetailBatch({ limit: payload.detailLimit })
  const pdf = await MirrorService.runPdfBatch({ limit: payload.pdfLimit })
  return { ok: true, detail, pdf }
}

async function resolveToken(token, itemId) {
  if (isValidToken(token)) return token
  if (!itemId) return null
  const col = await itemsCol()
  const item = await col.findOne({ _id: itemId }, { projection: { token: 1 } })
  return isValidToken(item?.token) ? item.token : null
}

export default {
  run,
}
