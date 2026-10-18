// Fingerprint of everything a PDF build depends on, so a viewer can tell when
// the PDF on disk no longer matches the project. Shared by the MCP surface and
// the AI-assist run, which both record one per compile and compare it when a
// page, overview or search is looked at.
//
// The fingerprint is a list of entries (one per doc or file: path plus a digest
// of its content or id) together with the root document, the compiler and the
// image name. Two fingerprints differ for one of three reasons, in this order:
// the root document changed, the compiler or image changed, or some document or
// file changed (docs_changed).

import crypto from 'node:crypto'

/** Hex sha256 of a string, used for doc contents and the overall hash. */
export function digestContent(content) {
  return crypto
    .createHash('sha256')
    .update(String(content ?? ''), 'utf8')
    .digest('hex')
}

/**
 * Builds the fingerprint of a project's build inputs.
 *
 * `entries` is a list of `{ path, digest }`, where `digest` is a doc's content
 * hash (or its version when the caller has one) or a file's id. Entries are
 * sorted by path, so the same inputs always give the same hash.
 */
export function buildFingerprint({
  rootDocPath = null,
  compiler = null,
  imageName = null,
  entries = [],
} = {}) {
  const sorted = entries
    .map(entry => ({
      path: String(entry.path ?? '').replace(/^\//, ''),
      digest: String(entry.digest ?? ''),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const contentHash = digestContent(
    JSON.stringify([
      rootDocPath ?? '',
      compiler ?? '',
      imageName ?? '',
      sorted.map(entry => [entry.path, entry.digest]),
    ])
  )
  return {
    contentHash,
    rootDocPath: rootDocPath ?? null,
    compiler: compiler ?? null,
    imageName: imageName ?? null,
    entries: sorted,
  }
}

/**
 * Compares the fingerprint recorded at compile time with the current one.
 *
 * Returns null when they match, otherwise `{ reason, changed }` where `reason`
 * is 'root_changed' | 'compiler_changed' | 'docs_changed' and `changed` lists
 * every path added, removed or edited, sorted.
 */
export function diffFingerprints(recorded, current) {
  if (!recorded || !current) return null
  if (recorded.contentHash === current.contentHash) return null

  const changed = changedPaths(recorded.entries || [], current.entries || [])
  if (recorded.rootDocPath !== current.rootDocPath) {
    return { reason: 'root_changed', changed }
  }
  if (
    recorded.compiler !== current.compiler ||
    recorded.imageName !== current.imageName
  ) {
    return { reason: 'compiler_changed', changed }
  }
  return { reason: 'docs_changed', changed }
}

function changedPaths(before, after) {
  const beforeMap = new Map(before.map(entry => [entry.path, entry.digest]))
  const afterMap = new Map(after.map(entry => [entry.path, entry.digest]))
  const paths = new Set()
  for (const [path, digest] of beforeMap) {
    if (afterMap.get(path) !== digest) paths.add(path)
  }
  for (const [path, digest] of afterMap) {
    if (beforeMap.get(path) !== digest) paths.add(path)
  }
  return [...paths].sort()
}
