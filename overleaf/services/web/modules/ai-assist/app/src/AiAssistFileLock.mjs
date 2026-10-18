// Serialises the read-modify-write of a chat or checkpoint file. Callers in
// this process queue on a local promise chain (no round trip); across web
// processes the same key is held through Overleaf's Redis-backed LockManager,
// so two processes cannot each read the file and then overwrite the other's
// write. LockManager is imported on first use, not at import time: an instance
// with the feature off never opens a Redis connection.

export const AI_ASSIST_FILE_LOCK_NAMESPACE = 'aiAssistFile'

const localLocks = new Map()
let lockManagerPromise = null
let customLockManager = null

export function setLockManagerForTesting(manager) {
  customLockManager = manager
}

function lockManager() {
  lockManagerPromise ??= import(
    '../../../../app/src/infrastructure/LockManager.mjs'
  ).then(module => module.default)
  return lockManagerPromise
}

function withLocalLock(key, task) {
  const previous = localLocks.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  const tail = next.catch(() => {})
  localLocks.set(key, tail)
  tail.then(() => {
    if (localLocks.get(key) === tail) localLocks.delete(key)
  })
  return next
}

/** Runs `task` while holding the lock for `key`, in this process and across processes. */
export function withAiAssistFileLock(key, task) {
  return withLocalLock(key, async () => {
    if (customLockManager) {
      return customLockManager.promises.runWithLock(
        AI_ASSIST_FILE_LOCK_NAMESPACE,
        key,
        task
      )
    }
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
