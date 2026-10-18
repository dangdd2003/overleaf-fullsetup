import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { fetchJson } from '@overleaf/fetch-utils'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import RestoreManager from '../../../../app/src/Features/History/RestoreManager.mjs'
import ProjectAuditLogHandler from '../../../../app/src/Features/Project/ProjectAuditLogHandler.mjs'
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
  const url = new URL(
    `${Settings.apis.project_history.url}/project/${projectId}/updates`
  )
  url.searchParams.set('min_count', String(Math.min(limit, MAX_LIMIT)))
  if (before != null) url.searchParams.set('before', String(before))
  const body = await HistoryManager.promises.injectUserDetails(
    await fetchJson(url, { headers: { 'X-User-Id': String(req.mcpUserId) } })
  )

  let entries = (body.updates || []).map(update => ({
    fromVersion: update.fromV,
    toVersion: update.toV,
    startedAt: toIso(update.meta?.start_ts),
    endedAt: toIso(update.meta?.end_ts),
    authors: (update.meta?.users || []).map(userName).filter(Boolean),
    origin: update.meta?.origin?.kind ?? null,
    labels: (update.labels || []).map(label => label.comment),
    changes: changedPaths(update),
  }))
  if (filter) {
    entries = entries.filter(entry =>
      entry.changes.some(
        c => c.path === filter || c.change === `renamed to ${filter}`
      )
    )
  }

  res.json({
    entries,
    nextBefore: body.nextBeforeTimestamp ?? null,
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
