import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import mime from 'mime-types'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import ProjectGetter from '../Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import ProjectZipStreamManager from '../Downloads/ProjectZipStreamManager.mjs'
import AuthorizationManager from '../Authorization/AuthorizationManager.mjs'
import HistoryManager from '../History/HistoryManager.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorController from '../Editor/EditorController.mjs'
import Errors from '../Errors/Errors.js'
import McpErrors from './McpErrors.mjs'
import McpUrlFetcher from './McpUrlFetcher.mjs'

function normalise(p) {
  return '/' + String(p || '').replace(/^\/+/, '').replace(/\/+$/, '')
}

async function getTree(req, res) {
  const { docs, files } = await ProjectEntityHandler.promises.getAllEntities(
    req.params.projectId
  )
  res.json({
    docs: docs.map(d => ({ path: normalise(d.path), id: d.doc._id.toString() })),
    files: files.map(f => ({
      path: normalise(f.path),
      id: f.file._id.toString(),
    })),
  })
}

async function getDoc(req, res) {
  const target = normalise(req.query?.path)
  const { docs } = await ProjectEntityHandler.promises.getAllEntities(
    req.params.projectId
  )
  const match = docs.find(d => normalise(d.path) === target)
  if (!match) {
    return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  }
  const { lines } = await DocstoreManager.promises.getDoc(
    req.params.projectId,
    match.doc._id
  )
  let out = lines
  const { startLine, endLine } = req.query || {}
  if (startLine != null || endLine != null) {
    const s = startLine != null ? Math.max(1, parseInt(startLine, 10)) - 1 : 0
    const e =
      endLine != null
        ? Math.min(lines.length, parseInt(endLine, 10))
        : lines.length
    out = lines.slice(s, e)
  }
  res.json({ path: target, content: out.join('\n') })
}

async function writeDoc(req, res) {
  const { path: docPath, content } = req.body || {}
  if (!docPath || typeof content !== 'string') {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'path and content are required'
    )
  }
  const target = normalise(docPath)
  if (target.split('/').some(seg => seg === '..' || seg === '.')) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'invalid path')
  }
  const projectId = req.params.projectId
  const lines = content.split('\n')
  const { doc } = await EditorController.promises.upsertDocWithPath(
    projectId,
    target,
    lines,
    'mcp',
    req.mcpUserId
  )
  const docId = doc?._id || doc?.id
  res.json({ status: 'ok', docId: docId ? docId.toString() : undefined })
}

async function createFolder(req, res) {
  const { path: folderPath } = req.body || {}
  if (!folderPath) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'path is required')
  }
  await EditorController.promises.mkdirp(
    req.params.projectId,
    normalise(folderPath),
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
  if (to.split('/').some(seg => seg === '..' || seg === '.')) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'invalid target path')
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
      McpErrors.CODES.VALIDATION,
      'destination path already exists'
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
    return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
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

  const norm = normalise(target)
  if (norm.split('/').some(seg => seg === '..' || seg === '.')) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'invalid path')
  }

  const name = norm.slice(norm.lastIndexOf('/') + 1)
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  const allowed = Settings.mcp?.allowedUploadExtensions || []
  const maxBytes = Settings.mcp?.maxUploadBytes || 0
  if (!allowed.includes(ext)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      `file extension .${ext} is not allowed`
    )
  }

  let buffer
  if (contentBase64 != null) {
    // The JSON body is capped by Settings.max_json_request_size (~12 MB) and
    // base64 inflates payloads by 4/3, so the real ceiling for `contentBase64`
    // is well below MCP_MAX_UPLOAD_MB. Reject early with a clear envelope
    // rather than letting the body parser emit a bare non-envelope 413.
    const jsonLimit = Settings.max_json_request_size || 12 * 1024 * 1024
    const maxBase64Bytes = Math.floor(jsonLimit * 0.7)
    if (String(contentBase64).length > maxBase64Bytes) {
      return McpErrors.send(
        res,
        McpErrors.CODES.VALIDATION,
        'contentBase64 payload is too large; use the url option for larger files'
      )
    }
    buffer = Buffer.from(String(contentBase64), 'base64')
  } else if (url != null) {
    try {
      ;({ buffer } = await McpUrlFetcher.fetchToBuffer(String(url), { maxBytes }))
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

  if (buffer.length > maxBytes) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'file is too large')
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
  const project = await ProjectGetter.promises.getProject(projectId, { name: 1 })
  if (!project) {
    return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
  }

  try {
    await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  } catch (err) {
    logger.warn({ err, projectId }, 'failed to flush project before zip download')
  }

  const safeName = (project.name || 'project').replace(/[^a-zA-Z0-9_\-\.]/g, '_')
  ProjectZipStreamManager.createZipStreamForProject(
    projectId,
    false,
    null,
    (error, stream) => {
      if (error) {
        return McpErrors.send(res, McpErrors.CODES.UPSTREAM, error.message)
      }
      res.contentType('application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`)
      stream.pipe(res)
    }
  )
}

async function downloadMultipleProjectsZip(req, res) {
  let projectIds = req.body?.projectIds || req.query?.projectIds
  if (typeof projectIds === 'string') {
    projectIds = projectIds
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  if (!Array.isArray(projectIds) || projectIds.length === 0) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'projectIds must be a non-empty array of project IDs'
    )
  }
  if (projectIds.length > 50) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'cannot download more than 50 projects at once'
    )
  }

  for (const pid of projectIds) {
    const canRead = await AuthorizationManager.promises.canUserReadProject(
      req.mcpUserId,
      pid,
      null
    )
    if (!canRead) {
      return McpErrors.send(
        res,
        McpErrors.CODES.NOT_FOUND,
        `project not found or access denied: ${pid}`
      )
    }
  }

  await Promise.allSettled(
    projectIds.map(pid => DocumentUpdaterHandler.promises.flushProjectToMongo(pid))
  )

  ProjectZipStreamManager.createZipStreamForMultipleProjects(
    projectIds,
    false,
    (error, stream) => {
      if (error) {
        return McpErrors.send(res, McpErrors.CODES.UPSTREAM, error.message)
      }
      res.contentType('application/zip')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="Overleaf Projects (${projectIds.length} items).zip"`
      )
      stream.pipe(res)
    }
  )
}

async function downloadFile(req, res) {
  const { projectId } = req.params
  const target = normalise(req.query?.path)
  if (!target || target === '/') {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'path is required')
  }

  const { docs, files } = await ProjectEntityHandler.promises.getAllEntities(
    projectId
  )

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
      return McpErrors.send(res, McpErrors.CODES.UPSTREAM, err.message)
    }

    const filename = path.basename(target)
    const contentType = mime.lookup(filename) || 'application/octet-stream'
    res.contentType(contentType)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    )
    if (contentLength) {
      res.setHeader('Content-Length', contentLength)
    }
    return pipeline(stream, res)
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
    const contentType =
      mime.lookup(filename) || 'text/plain; charset=utf-8'
    res.contentType(contentType)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    )
    return res.send(content)
  }

  // 3. Not found
  return McpErrors.send(res, McpErrors.CODES.NOT_FOUND)
}

async function searchFiles(req, res) {
  const { projectId } = req.params
  const query = req.query?.query
  if (!query || typeof query !== 'string' || !query.trim()) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'query is required')
  }

  const pathPrefix = req.query?.path ? normalise(req.query.path) : null
  let fileTypes = req.query?.fileTypes
  if (fileTypes) {
    if (typeof fileTypes === 'string') {
      fileTypes = fileTypes.split(',').map(ext => ext.trim().toLowerCase())
    } else if (Array.isArray(fileTypes)) {
      fileTypes = fileTypes.map(ext => String(ext).trim().toLowerCase())
    }
  }

  const caseSensitive =
    req.query?.caseSensitive === 'true' || req.query?.caseSensitive === true
  const maxMatches = Math.min(
    Math.max(1, parseInt(req.query?.maxMatches, 10) || 30),
    100
  )

  const { docs } = await ProjectEntityHandler.promises.getAllEntities(projectId)
  const matches = []

  const candidateDocs = (docs || []).filter(d => {
    const normalisedPath = normalise(d.path)
    if (pathPrefix && !normalisedPath.startsWith(pathPrefix)) {
      return false
    }
    if (fileTypes && fileTypes.length > 0) {
      const lower = normalisedPath.toLowerCase()
      const matchesType = fileTypes.some(ext => {
        const cleanExt = ext.startsWith('.') ? ext : `.${ext}`
        return lower.endsWith(cleanExt)
      })
      if (!matchesType) return false
    }
    return true
  })

  const targetQuery = caseSensitive ? query : query.toLowerCase()

  for (const d of candidateDocs) {
    if (matches.length >= maxMatches) break
    const { lines } = await DocstoreManager.promises.getDoc(
      projectId,
      d.doc._id
    )
    if (!Array.isArray(lines)) continue

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || ''
      const comparisonLine = caseSensitive ? line : line.toLowerCase()
      if (comparisonLine.includes(targetQuery)) {
        matches.push({
          path: normalise(d.path),
          line: i + 1,
          preview: line.trim(),
        })
        if (matches.length >= maxMatches) break
      }
    }
  }

  return res.json({
    query,
    totalMatches: matches.length,
    matches,
  })
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
}
