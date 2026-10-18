import { parentPort } from 'node:worker_threads'

// Never answers, so a job on it runs until the pool's timeout ends it.
parentPort.on('message', () => {})
