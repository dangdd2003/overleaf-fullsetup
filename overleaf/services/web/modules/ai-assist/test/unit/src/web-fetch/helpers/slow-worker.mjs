import { parentPort } from 'node:worker_threads'

parentPort.on('message', () => {
  // Deliberately do not answer to trigger timeout
})
