// Runs in a worker thread started by PdfWorkerPool.mjs. Parses one PDF with
// pdf.js and posts back only the plain readings. pdf.js loads at start-up, so a
// module that fails to resolve (Yarn PnP) crashes this worker, which the pool
// reports as a crash, not as a PDF that cannot be read.

import { parentPort } from 'node:worker_threads'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfPages } from './PdfPageReader.mjs'

parentPort.on('message', async ({ id, bytes }) => {
  try {
    const result = await readPdfPages(pdfjs, new Uint8Array(bytes))
    parentPort.postMessage({ id, success: true, result })
  } catch (err) {
    parentPort.postMessage({
      id,
      success: false,
      error: {
        code: err?.code === 'not_a_pdf' ? 'not_a_pdf' : 'failed',
        message: err?.message || 'The PDF could not be read.',
      },
    })
  }
})
