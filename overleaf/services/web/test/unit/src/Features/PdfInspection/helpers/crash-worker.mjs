import { parentPort } from 'node:worker_threads'

// Dies on a `crash` job, as a worker does when a job throws outside any handler;
// answers every other job at once.
parentPort.on('message', message => {
  if (message.kind === 'crash') throw new Error('worker crashed')
  parentPort.postMessage({ id: message.id, success: true, result: { ok: true } })
})
