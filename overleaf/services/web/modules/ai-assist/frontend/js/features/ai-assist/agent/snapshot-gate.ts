/**
 * The refresh every read tool depends on, done once and shared.
 *
 * Deliberately free of React, CodeMirror and the project contexts: the gate is
 * the one piece of `useProjectHandle` whose behaviour decides whether a tool
 * reports the project honestly, so it has to be testable on its own.
 */

/**
 * How long a successful refresh is reused for.
 *
 * A read tool costs a `/flush` plus a `/changes` round trip without this, and
 * an agent turn issues many of them back to back. Mirrors SNAPSHOT_TTL_MS in
 * AiAssistTools.mjs; edits invalidate the gate explicitly rather than waiting
 * the window out.
 */
export const SNAPSHOT_TTL_MS = 5000

/**
 * What a tool is told when the project files could not be loaded.
 *
 * It matters that this is an error and not an empty result. The snapshot backs
 * every read tool, so a failed refresh used to surface as `0 hits`, an empty
 * outline and "File not found" — a project that reads as genuinely empty. A
 * model cannot tell that apart from a real empty project, and goes on to answer
 * about a document it never saw.
 */
export class SnapshotUnavailableError extends Error {
  constructor(cause?: unknown) {
    const detail =
      cause && typeof cause === 'object' && 'message' in cause
        ? String((cause as Error).message)
        : cause
          ? String(cause)
          : ''
    super(
      `Could not load the project files${detail ? `: ${detail}` : ''}. The project contents are unavailable, so this result would be incomplete — do not treat the project as empty.`
    )
    this.name = 'SnapshotUnavailableError'
  }
}

export type SnapshotGate = {
  /** Resolves once the snapshot holds the project; rejects if it cannot. */
  ensure(): Promise<void>
  /** Marks the snapshot stale, so the next `ensure` refreshes it. */
  invalidate(): void
}

/**
 * Serialises and caches the snapshot refresh.
 *
 * Concurrent callers share one refresh rather than each starting their own, and
 * a refresh that succeeded is reused for `ttlMs`. A refresh that failed is
 * never cached: the next read tries again, and until one succeeds every read
 * fails loudly instead of reporting an empty project.
 */
export function createSnapshotGate(
  refresh: (() => Promise<void>) | undefined,
  {
    ttlMs = SNAPSHOT_TTL_MS,
    now = Date.now,
  }: { ttlMs?: number; now?: () => number } = {}
): SnapshotGate {
  let inFlight: Promise<void> | null = null
  let freshAt = 0

  return {
    invalidate() {
      freshAt = 0
    },

    async ensure() {
      if (!refresh) return
      if (freshAt !== 0 && now() - freshAt < ttlMs) return

      if (!inFlight) {
        inFlight = refresh()
          .then(() => {
            freshAt = now()
          })
          .finally(() => {
            inFlight = null
          })
      }

      try {
        await inFlight
      } catch (error) {
        throw new SnapshotUnavailableError(error)
      }
    },
  }
}

export type FolderLike = {
  name: string
  docs?: Array<{ _id?: string; name: string }>
  fileRefs?: Array<{ _id?: string; name: string }>
  folders?: FolderLike[]
}

export type ExtractedProjectFile = {
  path: string
  type: 'doc' | 'binary'
  size: number
  lines?: number
}

/**
 * Extracts a complete file list directly from the editor's live file tree structure.
 * Zero-network, resilient fallback when history or project snapshot fails.
 */
export function filesFromFileTree(
  folder: FolderLike | undefined | null,
  prefix = ''
): ExtractedProjectFile[] {
  if (!folder) return []
  const result: ExtractedProjectFile[] = []
  for (const doc of folder.docs || []) {
    result.push({
      path: prefix + doc.name,
      type: 'doc',
      size: 0,
    })
  }
  for (const file of folder.fileRefs || []) {
    result.push({
      path: prefix + file.name,
      type: 'binary',
      size: 0,
    })
  }
  for (const subFolder of folder.folders || []) {
    result.push(...filesFromFileTree(subFolder, `${prefix}${subFolder.name}/`))
  }
  return result
}
