import defaultStore, { TERMINAL_STATUSES } from './AiAssistRunStore.mjs'

/** Runs one user may have going at once, across every web process. */
export const MAX_CONCURRENT_RUNS_PER_USER = 5
/** Runs one web process may have going at once. */
export const MAX_ACTIVE_RUNS_PER_INSTANCE = 50
const READ_BATCH_SIZE = 20

/**
 * Non-terminal runs of the user in the user's active-runs index. Runs that
 * are finished, expired or belong to someone else do not count, and are
 * dropped from the index (a reconciled run leaves it only here).
 */
export async function countActiveRunsForUser(userId, { store = defaultStore } = {}) {
  if (!userId) return 0
  const runIds = await store.getActiveRunsForUser(userId)
  let count = 0
  for (let i = 0; i < runIds.length; i += READ_BATCH_SIZE) {
    const runs = await Promise.all(
      runIds
        .slice(i, i + READ_BATCH_SIZE)
        .map(runId => store.getRun(runId).catch(() => undefined))
    )
    for (const [j, run] of runs.entries()) {
      if (
        run &&
        run.userId === userId &&
        !TERMINAL_STATUSES.includes(run.status)
      ) {
        count++
      } else if (run !== undefined) {
        await store
          .removeActiveRunForUser(userId, runIds[i + j])
          .catch(() => {})
      }
    }
  }
  return count
}

/** Runs this process is driving right now. */
export function countRunsOnInstance(manager) {
  return manager?.activeRuns?.size ?? 0
}
