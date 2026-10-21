import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { fetchJson, RequestFailedError } from '@overleaf/fetch-utils'
import { Snapshot } from 'overleaf-editor-core'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import RestoreManager from '../../../../app/src/Features/History/RestoreManager.mjs'
import ProjectAuditLogHandler from '../../../../app/src/Features/Project/ProjectAuditLogHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import McpErrors from './McpErrors.mjs'
import {
  hasDotSegment,
  invalid,
  parseIntParam,
} from './McpRequestParams.mjs'

// project-history returns at least min_count updates per page.
const DEFAULT_LIMIT = 20
// Upper bound on one page, whatever limit a caller asks for, so one request
// cannot pull the whole history into memory.
const MAX_LIMIT = 1000
// Pages read in one request when a path filter leaves a page short.
const MAX_FILTER_PAGES = 10

/** project-history paths have no leading slash; MCP paths do. */
function historyPath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
}

function mcpPath(pathname) {
  return `/${historyPath(pathname)}`
}

/**
 * Make recent edits visible to history before reading it.
 *
 * Edits sit in a queue until project-history processes them, so without this
 * an edit the model just made would be missing from the list or the diff.
 */
async function flush(projectId) {
  try {
    await HistoryManager.promises.flushProject(projectId)
  } catch (err) {
    logger.warn({ err, projectId }, 'mcp history flush failed')
  }
}

function userName(user) {
  if (!user || typeof user !== 'object') return null
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ')
  return name || null
}

function toIso(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null
}

/** Paths an update touched, with what happened to each. */
function changedPaths(update) {
  const paths = new Map()
  for (const pathname of update.pathnames || []) {
    paths.set(mcpPath(pathname), 'edited')
  }
  for (const op of update.project_ops || []) {
    if (op.add) paths.set(mcpPath(op.add.pathname), 'added')
    if (op.remove) paths.set(mcpPath(op.remove.pathname), 'deleted')
    if (op.rename) {
      paths.set(mcpPath(op.rename.pathname), `renamed to ${mcpPath(op.rename.newPathname)}`)
    }
  }
  return [...paths].map(([path, change]) => ({ path, change }))
}

async function listHistory(req, res) {
  const { projectId } = req.params
  const limit = parseIntParam(req.query?.limit, DEFAULT_LIMIT, { min: 1 })
  const before = parseIntParam(req.query?.before, null, { min: 0 })
  if (limit === null || (req.query?.before != null && before === null)) {
    return invalid(
      res,
      'limit must be a whole number of at least 1, and before a timestamp from nextBefore'
    )
  }
  const filter = req.query?.path ? mcpPath(req.query.path) : null

  await flush(projectId)
  const entriesOf = updates =>
    (updates || []).map(update => ({
      fromVersion: update.fromV,
      toVersion: update.toV,
      startedAt: toIso(update.meta?.start_ts),
      endedAt: toIso(update.meta?.end_ts),
      authors: (update.meta?.users || []).map(userName).filter(Boolean),
      origin: update.meta?.origin?.kind ?? null,
      labels: (update.labels || []).map(label => label.comment),
      changes: changedPaths(update),
    }))
  const touches = entry =>
    entry.changes.some(
      c => c.path === filter || c.change === `renamed to ${filter}`
    )

  // A filter is applied to each page, so one page can come back empty while
  // older updates still match. Keep reading pages until the filtered list
  // fills, history runs out, or the page budget is spent; nextBefore then
  // resumes from the last page read, so no update is skipped.
  let entries = []
  let cursor = before
  for (let page = 0; page < MAX_FILTER_PAGES; page++) {
    const url = new URL(
      `${Settings.apis.project_history.url}/project/${projectId}/updates`
    )
    url.searchParams.set('min_count', String(Math.min(limit, MAX_LIMIT)))
    if (cursor != null) url.searchParams.set('before', String(cursor))
    const body = await HistoryManager.promises.injectUserDetails(
      await fetchJson(url, { headers: { 'X-User-Id': String(req.mcpUserId) } })
    )
    const pageEntries = entriesOf(body.updates)
    entries = entries.concat(filter ? pageEntries.filter(touches) : pageEntries)
    cursor = body.nextBeforeTimestamp ?? null
    if (!filter || entries.length >= limit || cursor == null) break
  }

  // A page can overshoot the limit. Keep only the newest `limit` entries and
  // resume just before the oldest one kept: project-history's `before` returns
  // updates older than the version given, so the dropped entries are read again.
  if (entries.length > limit) {
    entries = entries.slice(0, limit)
    cursor = entries[limit - 1].fromVersion
  }

  res.json({
    entries,
    nextBefore: cursor,
    path: filter,
  })
}

/**
 * Turn project-history's chunk list into line-anchored changes.
 *
 * Chunks are `{ u }` unchanged, `{ i }` inserted and `{ d }` deleted text, in
 * document order. Line numbers count through unchanged and inserted text, so
 * each change is anchored to a 1-based line of the newer version.
 */
export function summariseDiff(chunks) {
  const changes = []
  let line = 1
  let inserted = 0
  let deleted = 0
  for (const chunk of chunks) {
    const text = chunk.u ?? chunk.i ?? chunk.d ?? ''
    const newlines = (text.match(/\n/g) || []).length
    if (chunk.u != null) {
      line += newlines
      continue
    }
    const type = chunk.i != null ? 'insert' : 'delete'
    if (type === 'insert') inserted += text.length
    else deleted += text.length
    changes.push({
      type,
      line,
      text,
      author: userName(chunk.meta?.users?.[0]),
    })
    if (type === 'insert') line += newlines
  }
  return { changes, insertedChars: inserted, deletedChars: deleted }
}

async function getDiff(req, res) {
  const { projectId } = req.params
  const { path } = req.query || {}
  const from = parseIntParam(req.query?.fromVersion, null, { min: 0 })
  const to = parseIntParam(req.query?.toVersion, null, { min: 0 })
  if (!path || from === null || to === null || from > to) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'path, fromVersion and toVersion are required, with fromVersion <= toVersion',
      { hint: 'Take versions from list_history entries (fromVersion/toVersion).' }
    )
  }

  await flush(projectId)
  const url = new URL(
    `${Settings.apis.project_history.url}/project/${projectId}/diff`
  )
  url.searchParams.set('pathname', historyPath(path))
  url.searchParams.set('from', String(from))
  url.searchParams.set('to', String(to))
  const body = await HistoryManager.promises.injectUserDetails(
    await fetchJson(url, { headers: { 'X-User-Id': String(req.mcpUserId) } })
  )

  if (!Array.isArray(body.diff)) {
    return res.json({
      path: mcpPath(path),
      fromVersion: from,
      toVersion: to,
      binary: true,
      changes: [],
      insertedChars: 0,
      deletedChars: 0,
    })
  }
  res.json({
    path: mcpPath(path),
    fromVersion: from,
    toVersion: to,
    binary: false,
    ...summariseDiff(body.diff),
  })
}

/**
 * Whether the file's content can be fetched from history: a text document is
 * in the snapshot already, a binary file is a blob that is fetched later.
 * Mirrors the branch RestoreManager takes when it writes the file back.
 */
function needsBlob(snapshotFile) {
  return !snapshotFile.isEditable()
}

/**
 * Check that the file can be restored from the version, so that a bad version
 * or path is reported as a 404 rather than a generic upstream error.
 * RestoreManager fetches the old content before it deletes the current file,
 * so a fetch failure during the restore leaves the current file intact.
 *
 * @returns {Promise<{code: string, message: string, hint?: string} | null>}
 *   the error to send, or null when the restore can go ahead
 */
async function checkRestorable(projectId, version, pathname) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    overleaf: true,
  })
  if (!project?.overleaf?.history?.rangesSupportEnabled) {
    return {
      code: McpErrors.CODES.VALIDATION,
      message: 'this project does not support restoring files from history',
    }
  }

  let snapshot
  try {
    snapshot = Snapshot.fromRaw(
      await HistoryManager.promises.getContentAtVersion(projectId, version)
    )
  } catch (err) {
    if (
      err instanceof RequestFailedError &&
      [400, 404, 422].includes(err.response?.status)
    ) {
      return {
        code: McpErrors.CODES.NOT_FOUND,
        message: `version ${version} could not be loaded from the project history`,
        hint: 'Take version from list_history (toVersion of an entry).',
      }
    }
    throw err
  }

  const file = snapshot.getFile(pathname)
  if (!file) {
    return {
      code: McpErrors.CODES.NOT_FOUND,
      message: `${mcpPath(pathname)} is not in version ${version}`,
      hint: 'Use list_history with path to find a version that contains this file.',
    }
  }

  if (needsBlob(file)) {
    // Fetch the blob now and drop the stream, so a missing blob is reported
    // as an error before the restore starts.
    try {
      const { stream } = await HistoryManager.promises.requestBlob(
        project.overleaf.history.id,
        file.getHash()
      )
      stream.destroy()
    } catch (err) {
      if (err instanceof RequestFailedError && err.response?.status === 404) {
        return {
          code: McpErrors.CODES.NOT_FOUND,
          message: `content for ${mcpPath(pathname)} at version ${version} is not available in the history store`,
        }
      }
      throw err
    }
  }
  return null
}

async function restoreFile(req, res) {
  const { projectId } = req.params
  const { path, version } = req.body || {}
  if (typeof path !== 'string' || !path.trim()) {
    return invalid(res, 'path must be a non-empty string')
  }
  if (!Number.isInteger(version) || version < 0) {
    return invalid(res, 'version must be a non-negative integer', {
      hint: 'Take version from list_history (toVersion of the entry to go back to).',
    })
  }

  const pathname = historyPath(path)
  if (!pathname) {
    return invalid(res, 'path must name a file in the project')
  }
  if (hasDotSegment(pathname)) {
    return invalid(res, 'path must not contain . or .. segments')
  }
  const problem = await checkRestorable(projectId, version, pathname)
  if (problem) {
    return McpErrors.send(res, problem.code, problem.message, {
      hint: problem.hint,
    })
  }
  const entity = await RestoreManager.promises.revertFile(
    req.mcpUserId,
    projectId,
    version,
    pathname,
    {}
  )
  ProjectAuditLogHandler.addEntryIfManagedInBackground(
    projectId,
    'project-history-version-restored',
    req.mcpUserId,
    req.ip,
    { version, scope: 'file', pathname, restoredEntityId: entity._id }
  )
  res.json({
    path: mcpPath(pathname),
    version,
    type: entity.type,
    id: String(entity._id),
  })
}

export default { listHistory, getDiff, restoreFile }
