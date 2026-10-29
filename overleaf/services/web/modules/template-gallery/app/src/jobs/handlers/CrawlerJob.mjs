import TemplateCrawlerService from '../../services/TemplateCrawlerService.mjs'

/**
 * Background job handler for crawling the Algolia template catalog.
 *
 * @param {object} job - Job document from templateGalleryJobs
 * @param {object} ctx - Execution context (e.g., { cfg, runnerId, ... })
 * @returns {Promise<any>}
 */
export async function run(job, ctx = {}) {
  return TemplateCrawlerService.runCrawlBatch({ job, ctx, cfg: ctx.cfg })
}

export default {
  run,
}
