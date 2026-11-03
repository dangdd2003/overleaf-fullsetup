// overleaf/services/web/modules/template-gallery/app/src/jobs/handlers/DedupJob.mjs
import { runDedup } from '../../storage/DedupCollector.mjs'
import { DEFAULTS } from '../../TemplateGalleryDefaults.mjs'

/**
 * Background job for the dedup collector (storage/DedupCollector.mjs).
 * The payload selects the mode: { dryRun: true } reports only, { purge: true }
 * also deletes the blobs the run unset. The full report is stored in
 * configCol under _id: 'dedup'; the job result is a short summary.
 *
 * @param {object} job - Job document from templateGalleryJobs
 * @param {object} ctx - Execution context
 */
export async function run(job, ctx = {}) {
  const cfg = ctx.cfg || DEFAULTS
  const payload = job?.payload || {}
  const report = await runDedup({
    storageDir: cfg?.storageDir || DEFAULTS.storageDir,
    dryRun: payload.dryRun === true,
    purge: payload.purge === true,
    budgetMs: cfg?.runner?.dedupBudgetMs || undefined,
  })
  return {
    ok: true,
    dryRun: report.dryRun,
    skipped: report.skipped,
    groups: report.duplicates?.groups ?? 0,
    applied: report.duplicates?.applied ?? 0,
    freedFiles: report.freed?.files ?? 0,
    freedBytes: report.freed?.bytes ?? 0,
  }
}

export default {
  run,
}
