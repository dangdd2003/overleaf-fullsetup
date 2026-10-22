// Serialises the read-modify-write of a chat or checkpoint file. Callers in
// this process queue on a local promise chain (no round trip); across web
// processes the same key is held through Overleaf's Redis-backed LockManager,
// so two processes cannot each read the file and then overwrite the other's
// write. LockManager is imported on first use, not at import time: an instance
// with the feature off never opens a Redis connection.

const AI_ASSIST_FILE_LOCK_NAMESPACE = 'aiAssistFile'

let lockManagerPromise = null

function lockManager() {
  lockManagerPromise ??= import(
    '../../../../app/src/infrastructure/LockManager.mjs'
  ).then(module => module.default)
  return lockManagerPromise
}

/**
 * A lock for this process only: tasks for one key run one after another. Each
 * store makes its own, so its keys do not share a queue with another store's.
 */
export function createLocalLock() {
  const locks = new Map()
  return function withLocalLock(key, task) {
    // Every stored tail never rejects, so the chain can run on it directly
    const previous = locks.get(key) || Promise.resolve()
    const next = previous.then(task)
    const tail = next.catch(() => {})
    locks.set(key, tail)
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return next
  }
}

const withLocalLock = createLocalLock()

/** Runs `task` while holding the lock for `key`, in this process and across processes. */
export function withAiAssistFileLock(key, task) {
  return withLocalLock(key, async () => {
    if (process.env.NODE_ENV === 'test') {
      return task()
    }
    const manager = await lockManager()
    return manager.promises.runWithLock(
      AI_ASSIST_FILE_LOCK_NAMESPACE,
      key,
      task
    )
  })
}
