import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { promiseMapWithLimit } from '@overleaf/promise-utils'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectZipStreamManager from '../../../../app/src/Features/Downloads/ProjectZipStreamManager.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import HistoryManager from '../../../../app/src/Features/History/HistoryManager.mjs'
import DocstoreManager from '../../../../app/src/Features/Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import McpErrors from './McpErrors.mjs'
import { MAX_BINARY_BYTES, limitBinaryStream, tooLargeMessage } from './McpBinaryLimit.mjs'
import McpUrlFetcher from './McpUrlFetcher.mjs'
import { regexSearchLines } from './McpRegexSearch.mjs'
import {
  hasDotSegment,
  isTrueParam,
  parseIntParam,
} from './McpRequestParams.mjs'

// Most projects a single multi-project zip may bundle. Each one costs an access
// check and a flush, so the count is bounded.
const MAX_ZIP_PROJECTS = 500
// Documents fetched at a time while searching a project without a regex.
const SEARCH_BATCH_SIZE = 10

const MIME_TYPES = {
  '.tex': 'application/x-tex',
  '.latex': 'application/x-latex',
  '.bib': 'application/x-bibtex',
  '.cls': 'text/x-tex',
  '.sty': 'text/x-tex',
  '.bst': 'text/x-tex',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.eps': 'application/postscript',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.csv': 'text/csv',
}

function lookupMimeType(filename) {
  const ext = path.extname(filename).toLowerCase()
  return MIME_TYPES[ext] || null
}

/**
 * Canonical project path: a leading slash, forward slashes, no empty or '.'
 * segments and no trailing slash. A '..' segment is kept so the write paths
 * still refuse it; the MCP adapter resolves those before calling here.
 */
function normalise(p) {
  const segments = []
  for (const segment of String(p || '').replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    segments.push(segment)
  }
  return '/' + segments.join('/')
}

/** Every normalised path across the given entity lists. */
function pathsOf(...lists) {
  return lists.flat().map(entity => normalise(entity.path))
}

/**
 * Content-Disposition for a download. Node refuses header values containing
 * characters above U+00FF, so a name such as "bảng.png" needs the RFC 5987
 * `filename*` parameter alongside an ASCII fallback.
 */
function attachmentHeader(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  if (fallback === filename) {
    return `attachment; filename="${filename}"`
  }
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function baseName(p) {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** Levenshtein distance, two rows at a time. */
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[b.length]
}

/**
 * The paths closest to a path that did not match, for a not_found reply.
 * Case-insensitive; a prefix match ('/intro' for '/intro.tex') ranks first.
 *
 * @param {string} target the normalised path that was asked for
 * @param {string[]} paths every normalised path in the project
 * @returns {string[]} at most `limit` paths, closest first
 */
export function suggestPaths(target, paths, limit = 5) {
  const want = target.toLowerCase()
  const wantBase = baseName(want)
  const threshold = Math.max(2, Math.ceil(wantBase.length * 0.4))
  const scored = []
  for (const path of new Set(paths)) {
    const lower = path.toLowerCase()
    let distance = Math.min(editDistance(lower, want), editDistance(baseName(lower), wantBase))
    if (lower.startsWith(want)) distance = Math.min(distance, 1)
    if (distance <= threshold) scored.push({ path, distance })
  }
  return scored
    .sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(entry => entry.path)
}

/** Send a not_found reply that names the closest real paths, when there are any. */
function notFound(res, target, paths) {
  const candidates = suggestPaths(target, paths)
  return McpErrors.send(res, McpErrors.CODES.NOT_FOUND, `no document or file at ${target}`, {
    hint: candidates.length
      ? 'Retry with one of details.candidates, or call list_files for the exact paths.'
      : 'Call list_files to find the exact path.',
    details: candidates.length ? { candidates } : undefined,
  })
}

/**
 * Compile a glob into a predicate over normalised paths; see the adapter's
 * globMatcher. Walks a small NFA instead of a regex built from the user's
 * `*`s, so matching is O(path x pattern) and cannot backtrack.
 */
function globMatcher(glob) {
  const pattern = normalise(glob).slice(1).toLowerCase()
  const states = []
  const notSlash = c => c !== '/'
  const anyChar = () => true
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    const at = states.length
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // `**/`: nothing, or anything ending in a slash
        states.push({ skip: [at + 1, at + 3] })
        states.push({ loop: anyChar, skip: [at + 2] })
        states.push({ step: c => c === '/' })
        i += 2
      } else {
        states.push({ loop: anyChar, skip: [at + 1] })
        i += 1
      }
    } else if (ch === '*') {
      states.push({ loop: notSlash, skip: [at + 1] })
    } else if (ch === '?') {
      states.push({ step: notSlash })
    } else {
      states.push({ step: c => c === ch })
    }
  }
  const accept = states.length
  const addClosed = (live, start) => {
    const stack = [start]
    while (stack.length) {
      const state = stack.pop()
      if (live[state]) continue
      live[state] = true
      for (const next of states[state]?.skip ?? []) stack.push(next)
    }
  }
  const fullPath = pattern.includes('/')
  return path => {
    const subject = (fullPath ? path.slice(1) : baseName(path)).toLowerCase()
    let live = new Array(accept + 1).fill(false)
    addClosed(live, 0)
    for (const c of subject) {
      const next = new Array(accept + 1).fill(false)
      let any = false
      for (let state = 0; state < accept; state++) {
        if (!live[state]) continue
        const { step, loop } = states[state]
        if (step?.(c)) {
          addClosed(next, state + 1)
          any = true
        }
        if (loop?.(c)) {
          addClosed(next, state)
          any = true
        }
      }
      if (!any) return false
      live = next
    }
    return live[accept]
  }
}

async function getTree(req, res) {
  const projectId = req.params.projectId
  const [{ docs, files, folders }, project] = await Promise.all([
    ProjectEntityHandler.promises.getAllEntities(projectId),
    ProjectGetter.promises.getProject(projectId, { rootDoc_id: 1 }),
  ])
  const rootDocId = project?.rootDoc_id?.toString()
  const rootDoc = rootDocId
    ? docs.find(d => d.doc._id.toString() === rootDocId)
    : undefined
  res.json({
    docs: docs.map(d => ({
      path: normalise(d.path),
      id: d.doc._id.toString(),
    })),
    files: files.map(f => ({
      path: normalise(f.path),
      id: f.file._id.toString(),
      ...(typeof f.file.size === 'number' ? { size: f.file.size } : {}),
    })),
    folders: folders
      .map(f => ({ path: normalise(f.path), id: f.folder._id.toString() }))
      .filter(f => f.path !== '/'),
    rootDocPath: rootDoc ? normalise(rootDoc.path) : null,
  })
}

async function getDoc(req, res) {
  const projectId = req.params.projectId
  const target = normalise(req.query?.path)
  const { docs, files } = await ProjectEntityHandler.promises.getAllEntities(
    projectId
  )
  const match = docs.find(d => normalise(d.path) === target)
  if (!match) {
    if (files.some(f => normalise(f.path) === target)) {
      return McpErrors.send(
        res,
        McpErrors.CODES.VALIDATION,
        `${target} is a binary file, not a text document`,
        { hint: 'Use download_file for images, PDFs and other binary files.' }
      )
    }
    return notFound(res, target, pathsOf(docs, files))
  }
  const { lines } = await DocstoreManager.promises.getDoc(
    projectId,
    match.doc._id
  )
  const all = Array.isArray(lines) && lines.length > 0 ? lines : ['']
  const total = all.length
  const start = parseIntParam(req.query?.startLine, 1, { min: 1 })
  const requestedEnd = parseIntParam(req.query?.endLine, total, { min: 1 })
  if (start === null || requestedEnd === null) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'startLine and endLine must be positive integers'
    )
  }
  if (start > total) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      `startLine ${start} is past the end of ${target} (${total} lines)`,
      {
        hint: 'Use a startLine between 1 and totalLines.',
        details: { totalLines: total },
      }
    )
  }
  const end = Math.min(requestedEnd, total)
  if (end < start) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'endLine must not be before startLine'
    )
  }
  res.json({
    path: target,
    content: all.slice(start - 1, end).join('\n'),
    totalLines: total,
    startLine: start,
    endLine: end,
  })
}

/**
 * SHA-256 of a document's text, as lines joined by newlines. Edit clients send
 * the hash of what they read, so a write made on a stale read is refused.
 */
function contentHash(lines) {
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

async function writeDoc(req, res) {
  const { path: docPath, content, expectedHash } = req.body || {}
  if (!docPath || typeof content !== 'string') {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'path and content are required'
    )
  }
  if (expectedHash != null && typeof expectedHash !== 'string') {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'expectedHash must be a string'
    )
  }
  const target = normalise(docPath)
  if (hasDotSegment(target)) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'invalid path')
  }
  const projectId = req.params.projectId
  const { docs, files } = await ProjectEntityHandler.promises.getAllEntities(
    projectId
  )
  if (files.some(f => normalise(f.path) === target)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.CONFLICT,
      `a binary file already exists at ${target}`,
      { hint: 'Delete it with delete_file, or choose another path.' }
    )
  }
  const existing = docs.find(d => normalise(d.path) === target)
  let previousLineCount
  if (existing) {
    const { lines: previous } = await DocstoreManager.promises.getDoc(
      projectId,
      existing.doc._id
    )
    previousLineCount = Array.isArray(previous) ? previous.length : 0
    if (expectedHash != null) {
      const current = Array.isArray(previous) && previous.length > 0 ? previous : ['']
      if (contentHash(current) !== expectedHash) {
        return McpErrors.send(
          res,
          McpErrors.CODES.CONFLICT,
          `${target} changed since it was read; nothing was written`,
          { hint: 'Read the document again, reapply the edit, then write it.' }
        )
      }
    }
  } else if (expectedHash != null) {
    return McpErrors.send(
      res,
      McpErrors.CODES.CONFLICT,
      `${target} no longer exists; nothing was written`,
      { hint: 'Check the path with list_files, then create the document.' }
    )
  }
  const lines = content.split('\n')
  const { doc } = await EditorController.promises.upsertDocWithPath(
    projectId,
    target,
    lines,
    'mcp',
    req.mcpUserId
  )
  const docId = doc?._id || doc?.id
  res.json({
    status: 'ok',
    docId: docId ? docId.toString() : undefined,
    created: !existing,
    lineCount: lines.length,
    previousLineCount,
  })
}

async function createFolder(req, res) {
  const { path: folderPath } = req.body || {}
  if (!folderPath || typeof folderPath !== 'string') {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'path is required')
  }
  const target = normalise(folderPath)
  if (hasDotSegment(target)) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'invalid path')
  }
  await EditorController.promises.mkdirp(
    req.params.projectId,
    target,
    req.mcpUserId
  )
  res.json({ status: 'ok' })
}

async function moveEntity(req, res) {
  const { oldPath, newPath } = req.body || {}
  if (!oldPath || !newPath) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'oldPath and newPath are required'
    )
  }
  const projectId = req.params.projectId
  const from = normalise(oldPath)
  const to = normalise(newPath)
  if (from === to) {
    return res.json({ status: 'ok' })
  }
  // The root is in the folder list, so without this guard it would be matched
  // and moved or renamed like any other folder.
  if (from === '/') {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'the project root cannot be moved or renamed'
    )
  }
  if (hasDotSegment(to)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'invalid target path'
    )
  }

  const { docs, files, folders } =
    await ProjectEntityHandler.promises.getAllEntities(projectId)

  const targetExists =
    docs.some(d => normalise(d.path) === to) ||
    files.some(f => normalise(f.path) === to) ||
    folders.some(f => normalise(f.path) === to)
  if (targetExists) {
    return McpErrors.send(
      res,
      McpErrors.CODES.CONFLICT,
      `destination ${to} already exists`,
      { hint: 'Choose another newPath, or delete the existing entry first.' }
    )
  }

  let entityId, entityType
  const doc = docs.find(d => normalise(d.path) === from)
  const file = files.find(f => normalise(f.path) === from)
  const folder = folders.find(f => normalise(f.path) === from)
  if (doc) {
    entityId = doc.doc._id
    entityType = 'doc'
  } else if (file) {
    entityId = file.file._id
    entityType = 'file'
  } else if (folder) {
    entityId = folder.folder._id
    entityType = 'folder'
  } else {
    return notFound(res, from, pathsOf(docs, files, folders))
  }

  const srcFolderPath = normalise(path.dirname(from))
  const srcFolder = folders.find(f => normalise(f.path) === srcFolderPath)
  const srcFolderId = srcFolder?.folder?._id?.toString()

  const destFolderPath = normalise(path.dirname(to))
  const newName = path.basename(to)

  let destFolder = folders.find(f => normalise(f.path) === destFolderPath)
  if (!destFolder) {
    const { lastFolder } = await EditorController.promises.mkdirp(
      projectId,
      destFolderPath,
      req.mcpUserId
    )
    destFolder = { folder: lastFolder }
  }

  const movedFolders = srcFolderPath !== destFolderPath
  const renamed = path.basename(from) !== newName

  if (movedFolders) {
    await EditorController.promises.moveEntity(
      projectId,
      entityId.toString(),
      destFolder.folder._id.toString(),
      entityType,
      req.mcpUserId,
      'mcp'
    )
  }
  if (renamed) {
    try {
      await EditorController.promises.renameEntity(
        projectId,
        entityId.toString(),
        entityType,
        newName,
        req.mcpUserId,
        'mcp'
      )
    } catch (renameErr) {
      if (movedFolders && srcFolderId) {
        try {
          await EditorController.promises.moveEntity(
            projectId,
            entityId.toString(),
            srcFolderId,
            entityType,
            req.mcpUserId,
            'mcp'
          )
        } catch {
          // ignore rollback error to propagate rename failure
        }
      }
      throw renameErr
    }
  }
  res.json({ status: 'ok' })
}

async function uploadFile(req, res) {
  const { path: target, contentBase64, url } = req.body || {}
  if (!target || typeof target !== 'string') {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'path is required')
  }
  if (
    (contentBase64 != null && typeof contentBase64 !== 'string') ||
    (url != null && typeof url !== 'string')
  ) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'contentBase64 and url must be strings'
    )
  }

  const norm = normalise(target)
  if (hasDotSegment(norm)) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'invalid path')
  }

  let buffer
  if (contentBase64 != null) {
    // The JSON body is capped by the 70 MB limit.
    buffer = Buffer.from(String(contentBase64), 'base64')
    if (buffer.length > Settings.maxUploadSize) {
      return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'file is too large')
    }
  } else if (url != null) {
    try {
      ;({ buffer } = await McpUrlFetcher.fetchToBuffer(String(url), {
        maxBytes: Settings.maxUploadSize,
      }))
    } catch (err) {
      return McpErrors.send(
        res,
        McpErrors.CODES.VALIDATION,
        `url fetch rejected: ${err.info?.code || 'error'}`
      )
    }
  } else {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'contentBase64 or url is required'
    )
  }

  const tmp = path.join(
    os.tmpdir(),
    `mcp-upload-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`
  )
  await fs.writeFile(tmp, buffer)
  try {
    const { file } = await EditorController.promises.upsertFileWithPath(
      req.params.projectId,
      norm,
      tmp,
      null,
      'mcp',
      req.mcpUserId
    )
    res.json({ status: 'ok', path: norm, fileId: file?._id?.toString() })
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

async function downloadProjectZip(req, res) {
  const { projectId } = req.params
  const project = await ProjectGetter.promises.getProject(projectId, {
    name: 1,
  })
  if (!project) {
    return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  }

  try {
    await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  } catch (err) {
    logger.warn(
      { err, projectId },
      'failed to flush project before zip download'
    )
  }

  const safeName = (project.name || 'project').replace(/[^a-zA-Z0-9_\-.]/g, '_')
  ProjectZipStreamManager.createZipStreamForProject(
    projectId,
    false,
    null,
    (error, stream) => {
      if (error) {
        return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
      }
      res.contentType('application/zip')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeName}.zip"`
      )
      pipeline(stream, limitBinaryStream(), res).catch(() => {})
    }
  )
}

/**
 * Name a multi-project bundle after the moment it was exported.
 *
 * A bundle has no project name to borrow, so the export time identifies it,
 * written the way someone reading their downloads folder would want to read
 * it. It keeps Overleaf's own "Overleaf Projects (N items)" phrasing, dates
 * first so the names still sort chronologically, and says UTC out loud
 * because the server has no idea what clock the reader is on. The clock uses
 * hyphens rather than colons: a colon is illegal in a Windows filename.
 *
 * e.g. Overleaf Projects 2026-09-21 14-25-30 UTC (3 projects).zip
 */
function bundleFilename(count, now = new Date()) {
  const [date, clock] = now
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .split('T')
  return `Overleaf Projects ${date} ${clock.replace(/:/g, '-')} UTC (${count} project${count === 1 ? '' : 's'}).zip`
}

async function downloadMultipleProjectsZip(req, res) {
  let projectIds = req.body?.projectIds || req.query?.projectIds
  if (typeof projectIds === 'string') {
    projectIds = projectIds
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  // Every id must be a plain string. An object here (e.g. {"$ne": null}) would
  // reach the Mongo queries below as an operator and match arbitrary projects.
  if (
    !Array.isArray(projectIds) ||
    projectIds.length === 0 ||
    projectIds.some(pid => typeof pid !== 'string' || !pid)
  ) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'projectIds must be a non-empty array of project IDs'
    )
  }
  if (projectIds.length > MAX_ZIP_PROJECTS) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      `at most ${MAX_ZIP_PROJECTS} projects can be bundled in one zip`
    )
  }
  const readable = await Promise.all(
    projectIds.map(pid =>
      AuthorizationManager.promises.canUserReadProject(req.mcpUserId, pid, null)
    )
  )
  const denied = projectIds.find((_, i) => !readable[i])
  if (denied !== undefined) {
    return McpErrors.send(
      res,
      McpErrors.CODES.NOT_FOUND,
      `project not found or access denied: ${denied}`
    )
  }

  await Promise.allSettled(
    projectIds.map(pid =>
      DocumentUpdaterHandler.promises.flushProjectToMongo(pid)
    )
  )

  ProjectZipStreamManager.createZipStreamForMultipleProjects(
    projectIds,
    false,
    (error, stream) => {
      if (error) {
        return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
      }
      res.contentType('application/zip')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${bundleFilename(projectIds.length)}"`
      )
      pipeline(stream, limitBinaryStream(), res).catch(() => {})
    }
  )
}

async function downloadFile(req, res) {
  const { projectId } = req.params
  const target = normalise(req.query?.path)
  if (!target || target === '/') {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'path is required')
  }

  const { docs, files } =
    await ProjectEntityHandler.promises.getAllEntities(projectId)

  // 1. Check if it is a binary file in FileStore / History
  const fileMatch = files.find(f => normalise(f.path) === target)
  if (fileMatch) {
    let stream, contentLength
    try {
      ;({ stream, contentLength } =
        await HistoryManager.promises.requestBlobWithProjectId(
          projectId,
          fileMatch.file.hash,
          'GET'
        ))
    } catch (err) {
      if (err instanceof Errors.NotFoundError) {
        return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
      }
      logger.error(
        { err, projectId, path: target },
        'error requesting blob for mcp download file'
      )
      return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
    }

    if (contentLength > MAX_BINARY_BYTES) {
      stream.destroy()
      return McpErrors.send(
        res,
        McpErrors.CODES.TOO_LARGE,
        tooLargeMessage(contentLength)
      )
    }

    const filename = path.basename(target)
    const contentType = lookupMimeType(filename) || 'application/octet-stream'
    res.contentType(contentType)
    res.setHeader('Content-Disposition', attachmentHeader(filename))
    if (contentLength) {
      res.setHeader('Content-Length', contentLength)
    }
    return pipeline(stream, limitBinaryStream(), res)
  }

  // 2. Check if it is a text document in Docstore
  const docMatch = docs.find(d => normalise(d.path) === target)
  if (docMatch) {
    const { lines } = await DocstoreManager.promises.getDoc(
      projectId,
      docMatch.doc._id
    )
    const content = (lines || []).join('\n')
    const filename = path.basename(target)
    const contentType = lookupMimeType(filename) || 'text/plain; charset=utf-8'
    res.contentType(contentType)
    res.setHeader('Content-Disposition', attachmentHeader(filename))
    return res.send(content)
  }

  // 3. Not found
  return notFound(res, target, pathsOf(docs, files))
}

async function searchFiles(req, res) {
  const { projectId } = req.params
  const query = req.query?.query
  if (!query || typeof query !== 'string' || !query.trim()) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'query is required')
  }

  const regex = isTrueParam(req.query?.regex)
  const caseSensitive = isTrueParam(req.query?.caseSensitive)
  const maxMatches = parseIntParam(req.query?.maxMatches, 50, { min: 1 })
  const contextLines = parseIntParam(req.query?.contextLines, 0, { min: 0 })
  if (maxMatches === null || contextLines === null) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'maxMatches must be at least 1 and contextLines at least 0'
    )
  }

  const folder = req.query?.path ? normalise(req.query.path) : '/'
  const inScope = path =>
    folder === '/' || path === folder || path.startsWith(`${folder}/`)
  const matchesGlob = req.query?.glob ? globMatcher(req.query.glob) : () => true

  let matchesLine
  if (regex) {
    try {
      // Compile here so an invalid pattern fails fast; the search itself
      // runs in a worker that can be stopped (see McpRegexSearch)
      // eslint-disable-next-line no-new
      new RegExp(query, caseSensitive ? '' : 'i')
    } catch (err) {
      return McpErrors.send(
        res,
        McpErrors.CODES.VALIDATION,
        `invalid regular expression: ${err.message}`,
        { hint: 'Escape regex metacharacters, or pass regex: false for a literal search.' }
      )
    }
  } else {
    const needle = caseSensitive ? query : query.toLowerCase()
    matchesLine = line =>
      (caseSensitive ? line : line.toLowerCase()).includes(needle)
  }

  const { docs } = await ProjectEntityHandler.promises.getAllEntities(projectId)
  const candidates = docs
    .map(d => ({ path: normalise(d.path), id: d.doc._id }))
    .filter(d => inScope(d.path) && matchesGlob(d.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const matches = []
  let filesSearched = 0
  let truncated = false
  const trimmed = line => String(line ?? '').trim()
  const matchAt = (path, lines, i) => ({
    path,
    line: i + 1,
    text: trimmed(lines[i]),
    before: lines.slice(Math.max(0, i - contextLines), i).map(trimmed),
    after: lines.slice(i + 1, i + 1 + contextLines).map(trimmed),
  })

  if (regex) {
    const docLines = await promiseMapWithLimit(
      10,
      candidates,
      async d => {
        const { lines } = await DocstoreManager.promises.getDoc(projectId, d.id)
        return Array.isArray(lines) ? lines : []
      }
    )
    filesSearched = docLines.length
    // A pattern can run for as long as it likes; the search stops only when
    // the client has gone away, so nobody waits on a response it cannot get.
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    let hits
    try {
      hits = await regexSearchLines({
        query,
        caseSensitive,
        docs: docLines,
        limit: maxMatches + 1,
        signal: abort.signal,
      })
    } catch (err) {
      if (err.name === 'AbortError') return
      if (err.name === 'RegexTimeoutError') {
        return McpErrors.send(
          res,
          McpErrors.CODES.VALIDATION,
          'the regular expression took too long to search this project',
          {
            hint: 'Use a simpler pattern, or narrow the search with path or glob.',
          }
        )
      }
      throw err
    }
    truncated = hits.length > maxMatches
    for (const { doc, line } of hits.slice(0, maxMatches)) {
      matches.push(matchAt(candidates[doc].path, docLines[doc], line))
    }
    return res.json({
      query,
      regex,
      caseSensitive,
      totalMatches: matches.length,
      truncated,
      filesSearched,
      matches,
    })
  }

  // Documents are fetched a batch at a time, so a large project is not one
  // round trip per document. The early stop still happens within a batch.
  search: for (
    let start = 0;
    start < candidates.length;
    start += SEARCH_BATCH_SIZE
  ) {
    const batch = candidates.slice(start, start + SEARCH_BATCH_SIZE)
    const batchDocs = await Promise.all(
      batch.map(d => DocstoreManager.promises.getDoc(projectId, d.id))
    )
    for (let k = 0; k < batch.length; k++) {
      const d = batch[k]
      const { lines } = batchDocs[k]
      filesSearched++
      if (!Array.isArray(lines)) continue
      for (let i = 0; i < lines.length; i++) {
        if (!matchesLine(lines[i] || '')) continue
        if (matches.length >= maxMatches) {
          truncated = true
          break search
        }
        matches.push(matchAt(d.path, lines, i))
      }
    }
  }

  return res.json({
    query,
    regex,
    caseSensitive,
    totalMatches: matches.length,
    truncated,
    filesSearched,
    matches,
  })
}

/**
 * Delete a document, binary file or folder. A folder takes its contents with
 * it, and the project's root document is never removed.
 */
async function deleteEntity(req, res) {
  const { projectId } = req.params
  if (typeof req.query?.path !== 'string' || !req.query.path.trim()) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'path is required')
  }
  const target = normalise(req.query.path)
  if (target === '/') {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'the project root cannot be deleted'
    )
  }

  const [{ docs, files, folders }, project] = await Promise.all([
    ProjectEntityHandler.promises.getAllEntities(projectId),
    ProjectGetter.promises.getProject(projectId, { rootDoc_id: 1 }),
  ])
  const doc = docs.find(d => normalise(d.path) === target)
  const file = files.find(f => normalise(f.path) === target)
  const folder = folders.find(f => normalise(f.path) === target)
  if (!doc && !file && !folder) {
    return notFound(res, target, pathsOf(docs, files, folders))
  }

  const rootDocId = project?.rootDoc_id?.toString()
  const insideTarget = path => path === target || path.startsWith(`${target}/`)
  if (
    rootDocId &&
    docs.some(
      d =>
        d.doc._id.toString() === rootDocId && insideTarget(normalise(d.path))
    )
  ) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'refusing to delete the root document',
      {
        hint: 'The root document cannot be removed through the MCP API; delete it in the Overleaf editor instead.',
      }
    )
  }

  let entityId
  let entityType
  let deleted
  if (doc) {
    entityId = doc.doc._id
    entityType = 'doc'
    deleted = { docs: 1, files: 0, folders: 0 }
  } else if (file) {
    entityId = file.file._id
    entityType = 'file'
    deleted = { docs: 0, files: 1, folders: 0 }
  } else {
    const within = list => list.filter(e => insideTarget(normalise(e.path))).length
    entityId = folder.folder._id
    entityType = 'folder'
    deleted = {
      docs: within(docs),
      files: within(files),
      folders: within(folders),
    }
  }

  await EditorController.promises.deleteEntity(
    projectId,
    entityId.toString(),
    entityType,
    'mcp',
    req.mcpUserId
  )
  res.json({ status: 'ok', path: target, deleted })
}

export default {
  getTree,
  getDoc,
  writeDoc,
  createFolder,
  moveEntity,
  uploadFile,
  downloadFile,
  downloadProjectZip,
  downloadMultipleProjectsZip,
  searchFiles,
  deleteEntity,
}
