import { buildIndexFile } from '../index-build.mjs'
import { pageMap } from '../pages.mjs'
import { htmlToMarkdown } from './html.mjs'
import { pdfToText } from './pdf.mjs'

/**
 * The work an extraction worker does, also run in-process when the pool has
 * no workers. Must not import pool.mjs: a worker that loaded it would start
 * a pool of its own.
 */
export async function runJobInline(job) {
  switch (job.kind) {
    case 'html':
      return htmlToMarkdown(job.html, job.url)
    case 'pdf':
      // pdfToText copies the bytes once, which also covers a structured clone
      return pdfToText(job.body, { url: job.url, ...job.options })
    case 'index':
      return buildIndexFile(job.text, job.file, job.size)
    case 'pagemap':
      return pageMap(job.text, job.size)
    default:
      throw new Error(`Unknown job kind: ${job.kind}`)
  }
}
