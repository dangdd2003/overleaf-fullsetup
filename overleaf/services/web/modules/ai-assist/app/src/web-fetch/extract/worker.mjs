import { parentPort } from 'node:worker_threads'
import { runJobInline } from './jobs.mjs'

if (parentPort) {
  parentPort.on('message', async message => {
    const { id, ...job } = message
    try {
      const result = await runJobInline(job)
      parentPort.postMessage({ id, success: true, result })
    } catch (err) {
      parentPort.postMessage({
        id,
        success: false,
        error: {
          message: err?.message || String(err),
          kind: err?.kind || 'content',
        },
      })
    }
  })
}
