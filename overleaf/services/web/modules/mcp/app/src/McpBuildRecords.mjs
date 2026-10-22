// What this web process knows about the builds it compiled for MCP: the
// fingerprint of the inputs each build was made from (so a later page view can
// tell the PDF is out of date) and the order of the builds (so a visual diff
// can find the build before one). Kept in memory and bounded; a build this
// process did not record is simply not judged.

export const MAX_PROJECTS = 200
export const MAX_BUILDS_PER_PROJECT = 20
// Each record keeps one entry per doc and file of its project, so the count of
// projects and builds alone does not bound memory for large projects.
const MAX_TOTAL_FINGERPRINT_ENTRIES = 100000

/**
 * @typedef {{
 *   buildId: string,
 *   clsiServerId: string|null,
 *   fromOverride: boolean,
 *   fingerprint: {
 *     rootDocPath: string|null,
 *     compiler: string|null,
 *     imageName: string|null,
 *     entries: Array<{path: string, digest: string}>
 *   }
 * }} BuildRecord
 */

/** @type {Map<string, Array<BuildRecord>>} projectId -> records, oldest first */
let byProject = new Map()

function totalFingerprintEntries() {
  let total = 0
  for (const builds of byProject.values()) {
    for (const record of builds) {
      total += record.fingerprint?.entries?.length ?? 0
    }
  }
  return total
}

/**
 * Remember a build. Re-recording a buildId replaces its record and moves it
 * to the newest end.
 *
 * @param {string} projectId
 * @param {{ buildId: string, clsiServerId?: string|null, fingerprint: object,
 *   fromOverride?: boolean }} record
 */
export function rememberBuild(projectId, record) {
  const key = String(projectId)
  const builds = (byProject.get(key) ?? []).filter(
    existing => existing.buildId !== record.buildId
  )
  builds.push({
    buildId: record.buildId,
    clsiServerId: record.clsiServerId ?? null,
    fingerprint: record.fingerprint,
    fromOverride: record.fromOverride === true,
  })
  if (builds.length > MAX_BUILDS_PER_PROJECT) {
    builds.splice(0, builds.length - MAX_BUILDS_PER_PROJECT)
  }
  // Re-insert so the project is the most recently used one.
  byProject.delete(key)
  byProject.set(key, builds)
  while (byProject.size > MAX_PROJECTS) {
    byProject.delete(byProject.keys().next().value)
  }
  // Large projects can exhaust the budget on their own; then drop the least
  // recently used other projects. The project just recorded is kept.
  while (
    byProject.size > 1 &&
    totalFingerprintEntries() > MAX_TOTAL_FINGERPRINT_ENTRIES
  ) {
    byProject.delete(byProject.keys().next().value)
  }
}

/**
 * @returns {BuildRecord|null} the record of a build this process compiled, or null
 */
export function findBuild(projectId, buildId) {
  return (
    (byProject.get(String(projectId)) ?? []).find(
      record => record.buildId === buildId
    ) ?? null
  )
}

/**
 * The newest build compiled for a project, or null when none is recorded.
 *
 * @returns {BuildRecord|null}
 */
export function latestBuild(projectId) {
  const builds = byProject.get(String(projectId)) ?? []
  return builds.length > 0 ? builds[builds.length - 1] : null
}

/**
 * The build compiled before `buildId` for the same project, or null when this
 * process has no earlier one.
 *
 * @returns {BuildRecord|null}
 */
export function previousBuild(projectId, buildId) {
  const builds = byProject.get(String(projectId)) ?? []
  const index = builds.findIndex(record => record.buildId === buildId)
  return index > 0 ? builds[index - 1] : null
}

/** Forget everything; for tests. */
export function resetBuildRecords() {
  byProject = new Map()
}
