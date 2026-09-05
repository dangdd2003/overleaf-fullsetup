import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import Settings from '@overleaf/settings'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import GoogleDriveClient from './GoogleDriveClient.mjs'
import GoogleDriveOAuthManager from './GoogleDriveOAuthManager.mjs'
import EditorController from '../Editor/EditorController.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import ProjectGetter from '../Project/ProjectGetter.mjs'
import ProjectCreationHandler from '../Project/ProjectCreationHandler.mjs'
import HistoryManager from '../History/HistoryManager.mjs'

/**
 * Regex matching LaTeX compilation artifacts and temporary build files.
 */
const IGNORED_EXTENSIONS_REGEX =
  /\.(aux|log|toc|out|synctex\.gz|fls|fdb_latexmk|bbl|blg|nav|snm|vrb|dvi|ps|lof|lot)$/i

/**
 * Operating system and version control noise files to ignore.
 */
const OS_NOISE_FILES = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '.git',
])

/**
 * Known binary file extensions.
 */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.pdf',
  '.eps',
  '.bmp',
  '.tiff',
  '.tif',
  '.ico',
  '.svgz',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.exe',
  '.bin',
  '.dat',
])

/**
 * Common MIME types by extension.
 */
const MIME_TYPES = {
  '.tex': 'text/x-tex',
  '.latex': 'text/x-tex',
  '.bib': 'text/plain',
  '.sty': 'text/plain',
  '.cls': 'text/plain',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.eps': 'application/postscript',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
}

/**
 * Safely converts string / ObjectId to an ObjectId instance if valid.
 *
 * @param {string|ObjectId} id
 * @returns {ObjectId|string}
 */
function _toObjectId(id) {
  if (!id) return null
  if (typeof id === 'object' && id._bsontype === 'ObjectID') {
    return id
  }
  if (typeof id === 'string' && ObjectId?.isValid?.(id)) {
    try {
      return new ObjectId(id)
    } catch {
      return id
    }
  }
  return id
}

/**
 * Normalizes relative entity paths by stripping leading slashes and standardizing separators.
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  if (!p || typeof p !== 'string') return ''
  return p.replace(/^[/\\]+/, '').replace(/[/\\]+/g, '/')
}

/**
 * Encodes a relative file path for use as a MongoDB field name.
 *
 * Mongo forbids `.` and `$` in field names, and file paths contain both, so
 * `pendingChanges` is keyed by this encoding rather than the raw path.
 * Percent-encoding `%` first keeps the transform reversible.
 *
 * @param {string} filePath
 * @returns {string}
 */
function encodePathKey(filePath) {
  return normalizePath(filePath)
    .replace(/%/g, '%25')
    .replace(/\./g, '%2E')
    .replace(/\$/g, '%24')
}

/**
 * Inverse of encodePathKey.
 *
 * @param {string} key
 * @returns {string}
 */
function decodePathKey(key) {
  return String(key)
    .replace(/%2E/g, '.')
    .replace(/%24/g, '$')
    .replace(/%25/g, '%')
}

const BACKOFF_BASE_MS = 5 * 60 * 1000
const BACKOFF_MAX_MS = 60 * 60 * 1000

/**
 * Records a sync failure for a project and puts it into an exponential
 * backoff window that every worker honours.
 *
 * @param {string|ObjectId} projectId
 * @param {Error} err
 * @returns {Promise<void>}
 */
async function recordSyncFailure(projectId, err) {
  const projectObjectId = _toObjectId(projectId)
  const existing = await db.googleDriveProjectStates.findOne({
    projectId: projectObjectId,
  })
  const failures = (existing?.consecutiveFailures || 0) + 1
  const backoffMs = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, failures - 1),
    BACKOFF_MAX_MS
  )

  await db.googleDriveProjectStates.updateOne(
    { projectId: projectObjectId },
    {
      $set: {
        consecutiveFailures: failures,
        backoffUntil: new Date(Date.now() + backoffMs),
        syncStatus: 'error',
        lastOutboundError: err?.message || String(err),
      },
    }
  )

  logger.warn(
    { projectId, failures, backoffMs, err },
    'GoogleDriveSync: project entering backoff after sync failure'
  )
}

/**
 * Clears a project's failure state after a successful sync.
 *
 * @param {string|ObjectId} projectId
 * @returns {Promise<void>}
 */
async function clearSyncFailure(projectId) {
  await db.googleDriveProjectStates.updateOne(
    { projectId: _toObjectId(projectId) },
    {
      $set: { consecutiveFailures: 0 },
      $unset: { backoffUntil: '', lastOutboundError: '' },
    }
  )
}

/**
 * Converts a normalizePath()-style relative path (no leading slash) into the
 * leading-slash form that ProjectEntityUpdateHandler's upsertDocWithPath /
 * upsertFileWithPath / deleteEntityWithPath expect for their elementPath
 * argument.
 *
 * Without the leading slash, Node's `path.dirname()` on a root-level file
 * (e.g. "main.tex") returns "." rather than "/". mkdirp() only special-cases
 * "/" as the project root - not "." - so it runs "." through per-segment
 * filename validation, which rejects a bare "." and throws
 * InvalidNameError('invalid element name'). That silently fails every
 * root-level file synced from Google Drive.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function toElementPath(relativePath) {
  return `/${relativePath}`
}

/**
 * Determines if a file path matches ignored LaTeX compilation artifacts or OS noise files.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isIgnoredFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return true
  }
  const cleanPath = filePath.trim()
  if (!cleanPath) {
    return true
  }

  // Check if any segment is an OS noise file or .git directory
  const segments = cleanPath.split(/[/\\]/)
  for (const segment of segments) {
    const segLower = segment.toLowerCase()
    if (OS_NOISE_FILES.has(segLower) || segLower.startsWith('.git')) {
      return true
    }
  }

  const baseName = path.basename(cleanPath)
  if (OS_NOISE_FILES.has(baseName.toLowerCase())) {
    return true
  }

  // Check LaTeX ignored extensions (including compound .synctex.gz)
  if (IGNORED_EXTENSIONS_REGEX.test(cleanPath)) {
    return true
  }

  return false
}

/**
 * Checks if a file is considered binary based on extension and MIME type.
 *
 * @param {string} filePath
 * @param {string} [mimeType]
 * @returns {boolean}
 */
function isBinaryFile(filePath, mimeType) {
  const ext = path.extname(filePath || '').toLowerCase()
  if (BINARY_EXTENSIONS.has(ext)) {
    return true
  }
  if (mimeType) {
    if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/x-latex' ||
      mimeType === 'application/x-tex' ||
      mimeType === 'application/json' ||
      mimeType === 'application/javascript'
    ) {
      return false
    }
    if (
      mimeType.startsWith('image/') ||
      mimeType === 'application/pdf' ||
      mimeType === 'application/zip' ||
      mimeType === 'application/octet-stream'
    ) {
      const textExts = new Set([
        '.tex',
        '.bib',
        '.sty',
        '.cls',
        '.txt',
        '.md',
        '.csv',
        '.json',
        '.yaml',
        '.yml',
        '.xml',
        '.html',
        '.tikz',
        '.dtx',
        '.ins',
        '.rnw',
      ])
      if (textExts.has(ext)) {
        return false
      }
      return true
    }
  }
  return false
}

/**
 * Returns the MIME type for a file name.
 *
 * @param {string} fileName
 * @returns {string}
 */
function _getMimeType(fileName) {
  const ext = path.extname(fileName || '').toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

/**
 * Generates a conflict copy path for concurrent edits:
 * `<baseName> (Google Drive Conflict YYYY-MM-DD-HHmm).<ext>`
 *
 * @param {string} filePath
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
function generateConflictPath(filePath, date = new Date()) {
  const cleanPath = normalizePath(filePath)
  const ext = path.extname(cleanPath)
  const dir = path.dirname(cleanPath)
  const base = path.basename(cleanPath, ext)

  const YYYY = date.getUTCFullYear()
  const MM = String(date.getUTCMonth() + 1).padStart(2, '0')
  const DD = String(date.getUTCDate()).padStart(2, '0')
  const HH = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')

  const timestamp = `${YYYY}-${MM}-${DD}-${HH}${mm}`
  const conflictName = ext
    ? `${base} (Google Drive Conflict ${timestamp})${ext}`
    : `${base} (Google Drive Conflict ${timestamp})`

  return dir === '.' || !dir ? conflictName : `${dir}/${conflictName}`
}

/**
 * Acquires a distributed project lock for Google Drive synchronization.
 *
 * @param {string|ObjectId} projectId
 * @param {number} [ttlMs=60000]
 * @returns {Promise<boolean>} True if lock acquired, false otherwise
 */
async function acquireProjectLock(projectId, ttlMs = 60000) {
  const projectObjectId = _toObjectId(projectId)
  const now = new Date()
  const lockExpiresAt = new Date(now.getTime() + ttlMs)

  try {
    const result = await db.googleDriveProjectStates.findOneAndUpdate(
      {
        projectId: projectObjectId,
        $or: [
          { isSyncing: { $ne: true } },
          { lockExpiresAt: { $lt: now } },
          { lockExpiresAt: null },
          { lockExpiresAt: { $exists: false } },
        ],
      },
      {
        $set: {
          isSyncing: true,
          lockExpiresAt,
        },
      },
      {
        returnDocument: 'after',
      }
    )

    const doc = result?.value || result
    if (doc && (doc.projectId || doc._id)) {
      return true
    }

    const existing = await db.googleDriveProjectStates.findOne({
      projectId: projectObjectId,
    })

    if (!existing) {
      try {
        await db.googleDriveProjectStates.insertOne({
          projectId: projectObjectId,
          isSyncing: true,
          lockExpiresAt,
          syncStatus: 'syncing',
          fileMap: {},
          createdAt: now,
          updatedAt: now,
        })
        return true
      } catch {
        return false
      }
    }

    return false
  } catch (err) {
    logger.warn({ err, projectId }, 'Failed to acquire project lock')
    return false
  }
}

/**
 * Releases a distributed project lock.
 *
 * @param {string|ObjectId} projectId
 * @returns {Promise<boolean>}
 */
async function releaseProjectLock(projectId) {
  const projectObjectId = _toObjectId(projectId)
  try {
    await db.googleDriveProjectStates.updateOne(
      { projectId: projectObjectId },
      {
        $set: {
          isSyncing: false,
          lockExpiresAt: null,
        },
      }
    )
    return true
  } catch (err) {
    logger.warn({ err, projectId }, 'Failed to release project lock')
    return false
  }
}

/**
 * Enforces a minimum interval between user-triggered manual syncs for a
 * project, independent of the automatic polling / debounced-outbound sync
 * paths (which are expected to run more often than this interval).
 *
 * Uses an atomic findOneAndUpdate so two rapid manual-sync requests for the
 * same project can't both pass the check.
 *
 * @param {string|ObjectId} projectId
 * @param {number} [cooldownMs=60000]
 * @returns {Promise<{allowed: true} | {allowed: false, retryAfterSeconds: number}>}
 */
async function enforceManualSyncCooldown(projectId, cooldownMs) {
  if (cooldownMs == null) {
    cooldownMs = (Settings.googleDrive?.manualSyncCooldownSeconds ?? 60) * 1000
  }
  const projectObjectId = _toObjectId(projectId)
  const now = new Date()
  const cutoff = new Date(now.getTime() - cooldownMs)

  const result = await db.googleDriveProjectStates.findOneAndUpdate(
    {
      projectId: projectObjectId,
      $or: [
        { lastManualSyncAt: { $exists: false } },
        { lastManualSyncAt: null },
        { lastManualSyncAt: { $lt: cutoff } },
      ],
    },
    { $set: { lastManualSyncAt: now } },
    { returnDocument: 'after' }
  )

  const doc = result?.value || result
  if (doc) {
    return { allowed: true }
  }

  const existing = await db.googleDriveProjectStates.findOne({
    projectId: projectObjectId,
  })

  if (!existing || !existing.lastManualSyncAt) {
    // No state document (or no prior manual sync) - nothing to throttle
    // against yet.
    return { allowed: true }
  }

  const elapsedMs =
    now.getTime() - new Date(existing.lastManualSyncAt).getTime()
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((cooldownMs - elapsedMs) / 1000)
  )
  return { allowed: false, retryAfterSeconds }
}

/**
 * Ensures a directory path exists inside a Google Drive parent folder, returning the innermost folder ID.
 *
 * @param {string|ObjectId} userId
 * @param {string} rootParentId
 * @param {string} dirPath
 * @param {string|ObjectId} [projectId]
 * @returns {Promise<string>}
 */
async function _ensureDriveDirectoryPath(
  userId,
  rootParentId,
  dirPath,
  projectId = null
) {
  const parts = dirPath.split(/[/\\]/).filter(Boolean)
  let currentParentId = rootParentId
  let accumulatedPath = ''

  for (const part of parts) {
    accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part
    currentParentId = await GoogleDriveClient.getOrCreateSubfolder(
      userId,
      currentParentId,
      part
    )
    if (projectId) {
      try {
        await db.googleDriveProjectStates.updateOne(
          { projectId: _toObjectId(projectId) },
          { $set: { [`folderMap.${currentParentId}`]: accumulatedPath } }
        )
      } catch {}
    }
  }

  return currentParentId
}

/**
 * Ensures a directory path exists inside an Overleaf project, returning the destination folder ID.
 *
 * @param {string|ObjectId} projectId
 * @param {string} folderPath - relative folder path (e.g. 'chapters' or 'sub/dir') or '.'
 * @param {string|ObjectId} userId
 * @returns {Promise<string|ObjectId>}
 */
async function _ensureFolderPathInOverleaf(projectId, folderPath, userId) {
  const cleanFolder = normalizePath(folderPath)
  if (!cleanFolder || cleanFolder === '.' || cleanFolder === '/') {
    const project = await ProjectGetter.promises.getProject(projectId, {
      rootFolder: true,
    })
    return project?.rootFolder?.[0]?._id
  }
  const elementPath = toElementPath(cleanFolder)
  const res = await EditorController.promises.mkdirp(
    projectId,
    elementPath,
    userId
  )
  const folder = res?.lastFolder || res?.folder || res
  return folder?._id || folder
}

/**
 * Resolves a Google Drive folder ID to its containing project state and relative path.
 *
 * @param {string|ObjectId} userId
 * @param {string} folderId
 * @param {string} rootFolderId
 * @param {Array<object>} projectStates
 * @param {Record<string, { state: object, relativePath: string }>} folderMap
 * @returns {Promise<{ state: object, relativePath: string } | null>}
 */
async function resolveDriveFolderHierarchy(
  userId,
  folderId,
  rootFolderId,
  projectStates,
  folderMap
) {
  if (!folderId || folderId === rootFolderId) {
    return null
  }
  if (folderMap[folderId]) {
    return folderMap[folderId]
  }

  const matchingState = projectStates.find(st => st.driveFolderId === folderId)
  if (matchingState) {
    const entry = { state: matchingState, relativePath: '' }
    folderMap[folderId] = entry
    return entry
  }

  try {
    const meta = await GoogleDriveClient.getFileMetadata(
      userId,
      folderId,
      'id,name,mimeType,parents,trashed'
    )
    if (!meta || !meta.parents || meta.parents.length === 0) {
      return null
    }

    const parentId = meta.parents[0]
    if (parentId === rootFolderId) {
      const st = projectStates.find(
        s => s.driveFolderId === folderId || s.folderName === meta.name
      )
      if (st) {
        const entry = { state: st, relativePath: '' }
        folderMap[folderId] = entry
        return entry
      }
      return null
    }

    const parentEntry = await resolveDriveFolderHierarchy(
      userId,
      parentId,
      rootFolderId,
      projectStates,
      folderMap
    )

    if (parentEntry && parentEntry.state) {
      const relPath = parentEntry.relativePath
        ? `${parentEntry.relativePath}/${meta.name}`
        : meta.name
      const entry = { state: parentEntry.state, relativePath: relPath }
      folderMap[folderId] = entry

      try {
        await db.googleDriveProjectStates.updateOne(
          { projectId: _toObjectId(parentEntry.state.projectId) },
          { $set: { [`folderMap.${folderId}`]: relPath } }
        )
      } catch {}

      return entry
    }
  } catch (err) {
    logger.debug(
      { err, folderId },
      'Could not resolve Google Drive folder hierarchy'
    )
  }

  return null
}

/**
 * Recursively lists all non-trashed files and folders in a Google Drive folder.
 *
 * @param {string|ObjectId} userId
 * @param {string} folderId
 * @returns {Promise<Array<object>>}
 */
async function listDriveFilesRecursively(userId, folderId) {
  const fileList = []

  async function traverse(currentFolderId, currentPath) {
    const q = `'${currentFolderId}' in parents and trashed = false`
    let pageToken = null
    do {
      const res = await GoogleDriveClient.listFiles(
        userId,
        q,
        'files(id,name,mimeType,parents,trashed,md5Checksum,modifiedTime,size),nextPageToken',
        pageToken
      )
      const files = res.files || []
      for (const file of files) {
        const itemPath = currentPath ? `${currentPath}/${file.name}` : file.name
        const isFolder = file.mimeType === 'application/vnd.google-apps.folder'
        fileList.push({
          ...file,
          relativePath: itemPath,
          isFolder,
        })
        if (isFolder) {
          await traverse(file.id, itemPath)
        }
      }
      pageToken = res.nextPageToken
    } while (pageToken)
  }

  await traverse(folderId, '')
  return fileList
}

/**
 * Pushes a document modification from Overleaf to Google Drive.
 *
 * @param {string|ObjectId} projectId
 * @param {string|ObjectId} docId
 * @param {string} rawPath
 * @param {number} [rev]
 * @returns {Promise<{ success?: boolean, driveFileId?: string, ignored?: boolean, unlinked?: boolean }>}
 */
async function handleOutboundDocUpdate(projectId, docId, rawPath, rev) {
  const cleanPath = normalizePath(rawPath)
  if (isIgnoredFile(cleanPath)) {
    return { ignored: true }
  }

  const projectObjectId = _toObjectId(projectId)
  const state = await db.googleDriveProjectStates.findOne({
    projectId: projectObjectId,
  })

  if (!state || !state.driveFolderId || !state.userId) {
    return { unlinked: true }
  }

  const userId = state.userId
  const { lines, rev: docRev } = await DocstoreManager.promises.getDoc(
    projectId,
    docId
  )

  const docContent = Array.isArray(lines) ? lines.join('\n') : lines || ''
  const contentBuffer = Buffer.from(docContent, 'utf8')

  const dirName = path.posix.dirname(cleanPath)
  const fileName = path.posix.basename(cleanPath)

  let parentFolderId = state.driveFolderId
  if (dirName && dirName !== '.') {
    parentFolderId = await _ensureDriveDirectoryPath(
      userId,
      state.driveFolderId,
      dirName
    )
  }

  const existingEntry = state.fileMap?.[cleanPath]
  const existingFileId = existingEntry?.driveFileId || null

  const uploadRes = await GoogleDriveClient.uploadFile(
    userId,
    parentFolderId,
    fileName,
    contentBuffer,
    'text/plain',
    existingFileId
  )

  const fileMapEntry = {
    driveFileId: uploadRes.id,
    md5Checksum: uploadRes.md5Checksum,
    modifiedTime: uploadRes.modifiedTime
      ? new Date(uploadRes.modifiedTime)
      : new Date(),
    rev: rev ?? docRev ?? 0,
    entityId: _toObjectId(docId),
    entityType: 'doc',
  }

  const updatedFileMap = {
    ...(state.fileMap || {}),
    [cleanPath]: fileMapEntry,
  }

  await db.googleDriveProjectStates.updateOne(
    { projectId: projectObjectId },
    {
      $set: {
        fileMap: updatedFileMap,
        lastSyncedAt: new Date(),
      },
    }
  )

  return { success: true, driveFileId: uploadRes.id, fileMapEntry }
}

/**
 * Pushes a binary file modification from Overleaf to Google Drive.
 *
 * @param {string|ObjectId} projectId
 * @param {string|ObjectId} fileId
 * @param {string} rawPath
 * @param {string} [hash]
 * @returns {Promise<{ success?: boolean, driveFileId?: string, ignored?: boolean, unlinked?: boolean }>}
 */
async function handleOutboundFileUpdate(projectId, fileId, rawPath, hash) {
  const cleanPath = normalizePath(rawPath)
  if (isIgnoredFile(cleanPath)) {
    return { ignored: true }
  }

  const projectObjectId = _toObjectId(projectId)
  const state = await db.googleDriveProjectStates.findOne({
    projectId: projectObjectId,
  })

  if (!state || !state.driveFolderId || !state.userId) {
    return { unlinked: true }
  }

  const userId = state.userId
  let fileHash = hash
  if (!fileHash) {
    const project = await ProjectGetter.promises.getProject(projectId)
    const { files } = ProjectEntityHandler.getAllEntitiesFromProject(project)
    const matchingFile = files.find(
      f =>
        f.file?._id?.toString() === fileId?.toString() ||
        f.path === cleanPath ||
        normalizePath(f.path) === cleanPath
    )
    fileHash = matchingFile?.file?.hash
  }

  if (!fileHash) {
    throw new OError('Cannot find file hash for outbound file upload', {
      projectId,
      fileId,
      path: cleanPath,
    })
  }

  const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
    projectId,
    fileHash,
    'GET'
  )

  const dirName = path.posix.dirname(cleanPath)
  const fileName = path.posix.basename(cleanPath)

  let parentFolderId = state.driveFolderId
  if (dirName && dirName !== '.') {
    parentFolderId = await _ensureDriveDirectoryPath(
      userId,
      state.driveFolderId,
      dirName
    )
  }

  const existingEntry = state.fileMap?.[cleanPath]
  const existingFileId = existingEntry?.driveFileId || null
  const mimeType = _getMimeType(fileName)

  const uploadRes = await GoogleDriveClient.uploadFile(
    userId,
    parentFolderId,
    fileName,
    stream,
    mimeType,
    existingFileId
  )

  const fileMapEntry = {
    driveFileId: uploadRes.id,
    md5Checksum: uploadRes.md5Checksum,
    modifiedTime: uploadRes.modifiedTime
      ? new Date(uploadRes.modifiedTime)
      : new Date(),
    rev: null,
    entityId: _toObjectId(fileId),
    entityType: 'file',
    // Overleaf-side content hash at the moment of this push, so a later
    // sync can tell "Overleaf changed again" apart from "nothing changed
    // since we pushed" for binary files, which have no diffable content to
    // compare the way docs do via rev.
    overleafHash: fileHash,
  }

  const updatedFileMap = {
    ...(state.fileMap || {}),
    [cleanPath]: fileMapEntry,
  }

  await db.googleDriveProjectStates.updateOne(
    { projectId: projectObjectId },
    {
      $set: {
        fileMap: updatedFileMap,
        lastSyncedAt: new Date(),
      },
    }
  )

  return { success: true, driveFileId: uploadRes.id, fileMapEntry }
}

/**
 * Pushes a file deletion from Overleaf to Google Drive.
 *
 * @param {string|ObjectId} projectId
 * @param {string} rawPath
 * @returns {Promise<{ success?: boolean, ignored?: boolean, unlinked?: boolean }>}
 */
async function handleOutboundDelete(projectId, rawPath) {
  const cleanPath = normalizePath(rawPath)
  if (isIgnoredFile(cleanPath)) {
    return { ignored: true }
  }

  const projectObjectId = _toObjectId(projectId)
  const state = await db.googleDriveProjectStates.findOne({
    projectId: projectObjectId,
  })

  if (!state || !state.driveFolderId || !state.userId) {
    return { unlinked: true }
  }

  const userId = state.userId
  const existingEntry = state.fileMap?.[cleanPath]

  if (existingEntry?.driveFileId) {
    try {
      await GoogleDriveClient.deleteFile(userId, existingEntry.driveFileId)
    } catch (err) {
      logger.warn(
        {
          err,
          projectId,
          path: cleanPath,
          driveFileId: existingEntry.driveFileId,
        },
        'Error deleting file from Google Drive'
      )
    }
  }

  const updatedFileMap = { ...(state.fileMap || {}) }
  delete updatedFileMap[cleanPath]

  await db.googleDriveProjectStates.updateOne(
    { projectId: projectObjectId },
    {
      $set: {
        fileMap: updatedFileMap,
        lastSyncedAt: new Date(),
      },
    }
  )

  return { success: true }
}

/**
 * Helper to create a subfolder in Google Drive using either getOrCreateProjectFolder or getOrCreateSubfolder.
 *
 * @param {string|ObjectId} userId
 * @param {string} rootFolderId
 * @param {string} folderName
 * @returns {Promise<string>}
 */
async function _createDriveFolder(userId, rootFolderId, folderName) {
  if (typeof GoogleDriveClient.getOrCreateProjectFolder === 'function') {
    const res = await GoogleDriveClient.getOrCreateProjectFolder(
      userId,
      rootFolderId,
      folderName
    )
    if (res) return res
  }
  return GoogleDriveClient.getOrCreateSubfolder(
    userId,
    rootFolderId,
    folderName
  )
}

/**
 * Resolves or creates a Google Drive folder for an Overleaf project under rootFolderId,
 * handling folder name collisions against folders bound to other projects.
 *
 * @param {string|ObjectId} userId
 * @param {string} rootFolderId
 * @param {string} projectName
 * @param {string|ObjectId} [projectId]
 * @returns {Promise<string>} Google Drive Folder ID
 */
async function getOrCreateProjectFolder(
  userId,
  rootFolderId,
  projectName,
  projectId = null
) {
  const projectObjectId = _toObjectId(projectId)
  const userObjectId = _toObjectId(userId)

  // 1. If state.driveFolderId is already stored and still valid in Drive, reuse it.
  if (projectObjectId) {
    const state = await db.googleDriveProjectStates.findOne({
      projectId: projectObjectId,
    })
    if (state?.driveFolderId) {
      try {
        const meta = await GoogleDriveClient.getFileMetadata(
          userId,
          state.driveFolderId,
          'id,name,parents,trashed'
        )
        if (
          meta &&
          !meta.trashed &&
          (!meta.parents || meta.parents.includes(rootFolderId))
        ) {
          const resolvedName = meta.name || state.folderName || projectName
          if (state.folderName !== resolvedName) {
            await db.googleDriveProjectStates.updateOne(
              { projectId: projectObjectId },
              { $set: { folderName: resolvedName } }
            )
          }
          return state.driveFolderId
        }
      } catch (err) {
        logger.debug(
          { err, driveFolderId: state.driveFolderId, projectId },
          'Existing driveFolderId invalid or not found in Google Drive'
        )
      }
    }
  }

  // 2. List folder children of rootFolderId
  const q = `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  const res = await GoogleDriveClient.listFiles(
    userId,
    q,
    'files(id,name,trashed,parents)'
  )
  const existingFolders = res?.files || []

  // Check if folder named projectName exists
  const exactMatch = existingFolders.find(f => f.name === projectName)
  if (exactMatch) {
    const boundToOther = await db.googleDriveProjectStates.findOne({
      userId: userObjectId,
      driveFolderId: exactMatch.id,
      ...(projectObjectId ? { projectId: { $ne: projectObjectId } } : {}),
    })

    if (!boundToOther) {
      if (projectObjectId) {
        await db.googleDriveProjectStates.updateOne(
          { projectId: projectObjectId },
          { $set: { driveFolderId: exactMatch.id, folderName: projectName } }
        )
      }
      return exactMatch.id
    }
  } else {
    // Exact name does not exist in Drive
    const newFolderId = await _createDriveFolder(
      userId,
      rootFolderId,
      projectName
    )
    if (projectObjectId) {
      await db.googleDriveProjectStates.updateOne(
        { projectId: projectObjectId },
        { $set: { driveFolderId: newFolderId, folderName: projectName } }
      )
    }
    return newFolderId
  }

  // 3. Collision: iterate suffix 1..100 testing "${projectName} ${suffix}"
  for (let suffix = 1; suffix <= 100; suffix++) {
    const candidateName = `${projectName} ${suffix}`
    const candidateFolder = existingFolders.find(f => f.name === candidateName)
    if (candidateFolder) {
      const candidateBound = await db.googleDriveProjectStates.findOne({
        userId: userObjectId,
        driveFolderId: candidateFolder.id,
        ...(projectObjectId ? { projectId: { $ne: projectObjectId } } : {}),
      })
      if (!candidateBound) {
        if (projectObjectId) {
          await db.googleDriveProjectStates.updateOne(
            { projectId: projectObjectId },
            {
              $set: {
                driveFolderId: candidateFolder.id,
                folderName: candidateName,
              },
            }
          )
        }
        return candidateFolder.id
      }
    } else {
      const newFolderId = await _createDriveFolder(
        userId,
        rootFolderId,
        candidateName
      )
      if (projectObjectId) {
        await db.googleDriveProjectStates.updateOne(
          { projectId: projectObjectId },
          { $set: { driveFolderId: newFolderId, folderName: candidateName } }
        )
      }
      return newFolderId
    }
  }

  // 4. Max collision attempts exceeded: set syncSuspended and suspendReason
  if (projectObjectId) {
    await db.googleDriveProjectStates.updateOne(
      { projectId: projectObjectId },
      {
        $set: {
          syncSuspended: true,
          suspendReason: 'duplicate-folder-name',
          syncStatus: 'error',
          lastError: 'Cannot resolve unique folder name after 100 attempts',
        },
      },
      { upsert: true }
    )
  }

  throw new OError('Cannot resolve unique folder name after 100 attempts', {
    projectId,
    projectName,
  })
}

/**
 * Performs full bidirectional reconciliation of an Overleaf project with its Google Drive folder.
 *
 * @param {string|ObjectId} projectId
 * @param {string|ObjectId} [userId]
 * @param {string} [driveFolderId]
 * @returns {Promise<{ success: boolean, syncedAt: Date }>}
 */
async function syncProject(projectId, userId, driveFolderId = null) {
  const projectObjectId = _toObjectId(projectId)
  const lockAcquired = await acquireProjectLock(projectId)
  if (!lockAcquired) {
    throw new OError('Could not acquire project lock for Google Drive sync', {
      projectId,
    })
  }

  try {
    const project = await ProjectGetter.promises.getProject(projectId)
    if (!project) {
      throw new OError('Project not found for sync', { projectId })
    }

    const effectiveUserId = userId || project.owner_ref
    const userObjectId = _toObjectId(effectiveUserId)

    const rootFolderId =
      await GoogleDriveClient.getOrCreateRootFolder(effectiveUserId)
    let projectFolderId = driveFolderId
    if (!projectFolderId) {
      projectFolderId = await getOrCreateProjectFolder(
        effectiveUserId,
        rootFolderId,
        project.name,
        projectId
      )
    }

    let state = await db.googleDriveProjectStates.findOne({
      projectId: projectObjectId,
    })

    const folderName = state?.folderName || project.name

    if (!state) {
      state = {
        projectId: projectObjectId,
        userId: userObjectId,
        driveFolderId: projectFolderId,
        folderName,
        fileMap: {},
        syncStatus: 'syncing',
        isSyncing: true,
      }
      await db.googleDriveProjectStates.insertOne(state)
    } else {
      await db.googleDriveProjectStates.updateOne(
        { projectId: projectObjectId },
        {
          $set: {
            driveFolderId: projectFolderId,
            folderName,
            userId: userObjectId,
            syncStatus: 'syncing',
          },
        }
      )
    }

    const fileMap = { ...(state.fileMap || {}) }

    // 1. Gather all entities from Overleaf
    const entities =
      await ProjectEntityHandler.promises.getAllEntities(projectId)
    const docs = await DocstoreManager.promises.getAllDocs(projectId)
    const docMap = {}
    for (const d of docs || []) {
      if (d?._id) {
        docMap[d._id.toString()] = d
      }
    }

    const overleafEntities = {}
    for (const docEntry of entities.docs || []) {
      const docPath = normalizePath(docEntry.path)
      if (!isIgnoredFile(docPath)) {
        const docIdStr = docEntry.doc?._id?.toString()
        const docContent = docMap[docIdStr]
        overleafEntities[docPath] = {
          type: 'doc',
          id: docEntry.doc?._id,
          name: docEntry.doc?.name,
          lines: docContent?.lines || [],
          rev: docContent?.rev || 0,
        }
      }
    }

    for (const fileEntry of entities.files || []) {
      const filePath = normalizePath(fileEntry.path)
      if (!isIgnoredFile(filePath)) {
        overleafEntities[filePath] = {
          type: 'file',
          id: fileEntry.file?._id,
          name: fileEntry.file?.name,
          hash: fileEntry.file?.hash,
        }
      }
    }

    // 2. Gather all files recursively from Google Drive
    const driveFiles = await listDriveFilesRecursively(
      effectiveUserId,
      projectFolderId
    )
    const driveFileMap = {}
    const folderMap = { ...(state.folderMap || {}) }
    for (const df of driveFiles) {
      if (!df.isFolder) {
        const cleanPath = normalizePath(df.relativePath)
        if (!isIgnoredFile(cleanPath)) {
          driveFileMap[cleanPath] = df
        }
      } else {
        folderMap[df.id] = normalizePath(df.relativePath)
      }
    }

    // 3. Reconcile Drive -> Overleaf
    for (const [relPath, driveFile] of Object.entries(driveFileMap)) {
      const ovEntity = overleafEntities[relPath]
      const lastMapped = fileMap[relPath]

      if (ovEntity) {
        const driveModifiedSinceSync =
          !lastMapped ||
          lastMapped.md5Checksum === undefined ||
          lastMapped.md5Checksum !== driveFile.md5Checksum

        let localModifiedSinceSync = false
        if (ovEntity.type === 'doc') {
          if (lastMapped && lastMapped.rev !== undefined) {
            localModifiedSinceSync = ovEntity.rev !== lastMapped.rev
          } else if (lastMapped?.md5Checksum) {
            const doc = docMap[ovEntity.id?.toString()] || ovEntity
            const lines = doc?.lines || []
            const content = Array.isArray(lines)
              ? lines.join('\n')
              : lines || ''
            const localHash = crypto
              .createHash('md5')
              .update(Buffer.from(content, 'utf8'))
              .digest('hex')
            localModifiedSinceSync = localHash !== lastMapped.md5Checksum
          }
        } else if (ovEntity.hash) {
          if (lastMapped?.overleafHash !== undefined) {
            localModifiedSinceSync = ovEntity.hash !== lastMapped.overleafHash
          } else if (lastMapped?.md5Checksum !== undefined) {
            localModifiedSinceSync = ovEntity.hash !== lastMapped.md5Checksum
          }
        }

        if (ovEntity.type === 'doc') {
          const driveBuffer = await GoogleDriveClient.downloadFileBuffer(
            effectiveUserId,
            driveFile.id
          )
          const driveContent = driveBuffer.toString('utf8')
          const ovContent = (ovEntity.lines || []).join('\n')
          let updatedRev = ovEntity.rev

          if (driveContent !== ovContent) {
            // Whether Drive's own copy has actually changed since the last
            // sync (not just "does it differ from Overleaf's current
            // content", which is trivially true whenever only one side
            // changed).
            logger.info(
              {
                projectId,
                relPath,
                driveModifiedSinceSync,
                localModifiedSinceSync,
                lastMappedRev: lastMapped?.rev,
                ovEntityRev: ovEntity.rev,
                lastMappedMd5: lastMapped?.md5Checksum,
                driveFileMd5: driveFile.md5Checksum,
              },
              'syncProject: doc content differs from Drive, deciding sync direction'
            )

            if (driveModifiedSinceSync && localModifiedSinceSync) {
              // Both sides changed since the last sync - genuine conflict.
              // Leave the live Overleaf doc untouched and land Drive's
              // version as a timestamped copy instead of overwriting it.
              const conflictPath = generateConflictPath(relPath)
              logger.warn(
                { projectId, path: relPath, conflictPath },
                'GoogleDriveSync: conflict detected, creating conflict copy'
              )
              const conflictLines = driveContent.split('\n')
              await EditorController.promises.upsertDocWithPath(
                projectId,
                toElementPath(conflictPath),
                conflictLines,
                'google-drive',
                effectiveUserId
              )

              const conflictRecord = {
                path: relPath,
                conflictPath,
                detectedAt: new Date(),
              }
              await db.googleDriveProjectStates.updateOne(
                { projectId: projectObjectId },
                {
                  $push: {
                    conflicts: {
                      $each: [conflictRecord],
                      $slice: -20,
                    },
                  },
                }
              )
            } else if (driveModifiedSinceSync) {
              // Confirmed only Drive changed - Overleaf's rev matches what
              // we last synced, so it's safe for Drive to win here.
              const driveLines = driveContent.split('\n')
              const upsertRes =
                await EditorController.promises.upsertDocWithPath(
                  projectId,
                  toElementPath(relPath),
                  driveLines,
                  'google-drive',
                  effectiveUserId
                )
              ovEntity.lines = driveLines
              updatedRev =
                upsertRes?.doc?.rev ?? upsertRes?.rev ?? (ovEntity.rev ?? 0) + 1
            } else {
              // Not confirmed that Drive actually changed - either only
              // Overleaf changed, or neither side's bookkeeping shows a
              // change yet content still differs (e.g. residual state left
              // by an earlier conflict, whose fallthrough recorded a rev
              // without ever pushing that content to Drive). Never
              // destructively overwrite the live Overleaf doc when we
              // aren't sure Drive changed - push instead, which only
              // touches Drive and can't lose local work.
              const pushRes = await handleOutboundDocUpdate(
                projectId,
                ovEntity.id,
                relPath,
                ovEntity.rev
              )
              if (pushRes?.fileMapEntry) {
                fileMap[relPath] = pushRes.fileMapEntry
              }
              continue
            }
          }

          fileMap[relPath] = {
            driveFileId: driveFile.id,
            md5Checksum: driveFile.md5Checksum,
            modifiedTime: driveFile.modifiedTime
              ? new Date(driveFile.modifiedTime)
              : new Date(),
            rev: updatedRev,
            entityId: ovEntity.id,
            entityType: 'doc',
          }
        } else {
          if (driveModifiedSinceSync && localModifiedSinceSync) {
            // Both sides changed since last sync - genuine conflict for binary file.
            const conflictPath = generateConflictPath(relPath)
            logger.warn(
              { projectId, path: relPath, conflictPath },
              'GoogleDriveSync: conflict detected, creating conflict copy'
            )
            const tempDir = process.env.TMPDIR || os.tmpdir()
            const tempFilePath = path.join(
              tempDir,
              `gdrive_sync_${crypto.randomBytes(8).toString('hex')}_${path.basename(conflictPath)}`
            )
            const driveBuffer = await GoogleDriveClient.downloadFileBuffer(
              effectiveUserId,
              driveFile.id
            )
            await fs.promises.writeFile(tempFilePath, driveBuffer)
            try {
              await EditorController.promises.upsertFileWithPath(
                projectId,
                toElementPath(conflictPath),
                tempFilePath,
                null,
                'google-drive',
                effectiveUserId
              )
            } finally {
              try {
                await fs.promises.unlink(tempFilePath)
              } catch {}
            }

            const conflictRecord = {
              path: relPath,
              conflictPath,
              detectedAt: new Date(),
            }
            await db.googleDriveProjectStates.updateOne(
              { projectId: projectObjectId },
              {
                $push: {
                  conflicts: {
                    $each: [conflictRecord],
                    $slice: -20,
                  },
                },
              }
            )
          } else if (localModifiedSinceSync && !driveModifiedSinceSync) {
            // Only Overleaf's file changed since the last sync - Drive's
            // copy is untouched. Push it instead of leaving Drive
            // permanently stale (there's no diffable content for binaries
            // the way docs have via rev, so this only fires once we've
            // actually recorded an Overleaf-side hash from a previous
            // sync/push to compare against).
            const pushRes = await handleOutboundFileUpdate(
              projectId,
              ovEntity.id,
              relPath,
              ovEntity.hash
            )
            if (pushRes?.fileMapEntry) {
              fileMap[relPath] = pushRes.fileMapEntry
            }
            continue
          } else if (driveModifiedSinceSync) {
            const tempDir = process.env.TMPDIR || os.tmpdir()
            const tempFilePath = path.join(
              tempDir,
              `gdrive_sync_${crypto.randomBytes(8).toString('hex')}_${path.basename(relPath)}`
            )
            const driveBuffer = await GoogleDriveClient.downloadFileBuffer(
              effectiveUserId,
              driveFile.id
            )
            await fs.promises.writeFile(tempFilePath, driveBuffer)
            try {
              await EditorController.promises.upsertFileWithPath(
                projectId,
                toElementPath(relPath),
                tempFilePath,
                null,
                'google-drive',
                effectiveUserId
              )
            } finally {
              try {
                await fs.promises.unlink(tempFilePath)
              } catch {}
            }
          }

          fileMap[relPath] = {
            driveFileId: driveFile.id,
            md5Checksum: driveFile.md5Checksum,
            modifiedTime: driveFile.modifiedTime
              ? new Date(driveFile.modifiedTime)
              : new Date(),
            rev: null,
            entityId: ovEntity.id,
            entityType: 'file',
            overleafHash: ovEntity.hash,
          }
        }
      } else if (lastMapped && lastMapped.driveFileId === driveFile.id) {
        // We previously synced this exact Drive file to this path, and it's
        // no longer an Overleaf entity - the user deleted it locally since
        // the last sync. Without this check, every sync would treat "still
        // in Drive, missing from Overleaf" as a brand-new file to pull in,
        // permanently resurrecting anything ever deleted on the Overleaf
        // side. Propagate the deletion outward instead, mirroring how
        // handleOutboundDelete removes a file from Drive.
        try {
          await GoogleDriveClient.deleteFile(effectiveUserId, driveFile.id)
        } catch (err) {
          logger.warn(
            { err, projectId, path: relPath, driveFileId: driveFile.id },
            'Error deleting file from Google Drive after local deletion'
          )
        }
        delete fileMap[relPath]
      } else {
        if (isBinaryFile(relPath, driveFile.mimeType)) {
          const tempDir = process.env.TMPDIR || os.tmpdir()
          const tempFilePath = path.join(
            tempDir,
            `gdrive_sync_${crypto.randomBytes(8).toString('hex')}_${path.basename(relPath)}`
          )
          const driveBuffer = await GoogleDriveClient.downloadFileBuffer(
            effectiveUserId,
            driveFile.id
          )
          await fs.promises.writeFile(tempFilePath, driveBuffer)
          let upsertFileRes = null
          try {
            upsertFileRes = await EditorController.promises.upsertFileWithPath(
              projectId,
              toElementPath(relPath),
              tempFilePath,
              null,
              'google-drive',
              effectiveUserId
            )
          } finally {
            try {
              await fs.promises.unlink(tempFilePath)
            } catch {}
          }
          fileMap[relPath] = {
            driveFileId: driveFile.id,
            md5Checksum: driveFile.md5Checksum,
            modifiedTime: driveFile.modifiedTime
              ? new Date(driveFile.modifiedTime)
              : new Date(),
            rev: null,
            entityId: upsertFileRes?.file?._id || upsertFileRes?._id,
            entityType: 'file',
          }
        } else {
          const driveBuffer = await GoogleDriveClient.downloadFileBuffer(
            effectiveUserId,
            driveFile.id
          )
          const driveContent = driveBuffer.toString('utf8')
          const driveLines = driveContent.split('\n')
          const upsertRes = await EditorController.promises.upsertDocWithPath(
            projectId,
            toElementPath(relPath),
            driveLines,
            'google-drive',
            effectiveUserId
          )
          const updatedRev = upsertRes?.doc?.rev ?? upsertRes?.rev ?? 0
          fileMap[relPath] = {
            driveFileId: driveFile.id,
            md5Checksum: driveFile.md5Checksum,
            modifiedTime: driveFile.modifiedTime
              ? new Date(driveFile.modifiedTime)
              : new Date(),
            rev: updatedRev,
            entityId: upsertRes?.doc?._id,
            entityType: 'doc',
          }
        }
      }
    }

    // 4. Overleaf entities missing in Drive or new in Overleaf
    for (const [relPath, ovEntity] of Object.entries(overleafEntities)) {
      if (!driveFileMap[relPath]) {
        if (fileMap[relPath]) {
          await EditorController.promises.deleteEntityWithPath(
            projectId,
            toElementPath(relPath),
            'google-drive',
            effectiveUserId
          )
          delete fileMap[relPath]
        } else {
          if (ovEntity.type === 'doc') {
            await handleOutboundDocUpdate(
              projectId,
              ovEntity.id,
              relPath,
              ovEntity.rev
            )
          } else {
            await handleOutboundFileUpdate(
              projectId,
              ovEntity.id,
              relPath,
              ovEntity.hash
            )
          }
        }
      }
    }

    await db.googleDriveProjectStates.updateOne(
      { projectId: projectObjectId },
      {
        $set: {
          fileMap,
          folderMap,
          syncStatus: 'idle',
          lastSyncedAt: new Date(),
          lastError: null,
        },
      }
    )

    return { success: true, syncedAt: new Date() }
  } catch (err) {
    logger.error({ err, projectId }, 'Error during Google Drive project sync')
    await db.googleDriveProjectStates.updateOne(
      { projectId: projectObjectId },
      {
        $set: {
          syncStatus: 'error',
          lastError: err.message || 'Sync error',
        },
      }
    )
    throw err
  } finally {
    await releaseProjectLock(projectId)
  }
}

/**
 * Creates a new blank Overleaf project and googleDriveProjectStates doc for a
 * Google Drive folder that isn't linked to any known project yet, then runs
 * an initial sync to pull its contents in.
 *
 * Shared by pollUserChanges (reacting to a live folder-creation event) and
 * reconcileExistingDriveProjects (actively listing current folders), so both
 * paths create projects the exact same way.
 *
 * Resolves project name collisions against existing projects (active, archived, or trashed)
 * by appending suffixes " (1)", " (2)", up to 100.
 *
 * @param {string|ObjectId} userId
 * @param {ObjectId|object} userObjectIdOrFile
 * @param {object} [fileMaybe]
 * @param {Record<string, object>} [projectByFolderId]
 * @param {Record<string, {state: object, relativePath: string}>} [folderMap]
 * @param {object[]} [projectStates]
 * @returns {Promise<object>} the newly created state doc
 */
async function _createProjectFromDriveFolder(
  userId,
  userObjectIdOrFile,
  fileMaybe,
  projectByFolderId = {},
  folderMap = {},
  projectStates = []
) {
  let userObjectId
  let file
  if (
    userObjectIdOrFile &&
    typeof userObjectIdOrFile === 'object' &&
    userObjectIdOrFile.id &&
    userObjectIdOrFile.name
  ) {
    file = userObjectIdOrFile
    userObjectId = _toObjectId(userId)
  } else {
    userObjectId = userObjectIdOrFile || _toObjectId(userId)
    file = fileMaybe
  }

  logger.info(
    { userId, folderName: file.name, folderId: file.id },
    'Creating new Overleaf project from Google Drive folder'
  )

  // Check for project name collisions against existing projects (including active, archived, and trashed)
  let resolvedProjectName = file.name
  const existingProjects = await ProjectGetter.promises.findUsersProjectsByName(
    userId,
    file.name
  )

  if (existingProjects && existingProjects.length > 0) {
    let uniqueFound = false
    for (let suffix = 1; suffix <= 100; suffix++) {
      const candidateName = `${file.name} (${suffix})`
      const collisions = await ProjectGetter.promises.findUsersProjectsByName(
        userId,
        candidateName
      )
      if (!collisions || collisions.length === 0) {
        resolvedProjectName = candidateName
        uniqueFound = true
        break
      }
    }

    if (!uniqueFound) {
      const suspendedState = {
        userId: userObjectId,
        driveFolderId: file.id,
        folderName: file.name,
        syncSuspended: true,
        suspendReason: 'duplicate-project-name',
        syncStatus: 'error',
        lastError: 'Cannot resolve unique project name after 100 attempts',
        createdAt: new Date(),
      }
      await db.googleDriveProjectStates.insertOne(suspendedState)
      if (projectByFolderId) projectByFolderId[file.id] = suspendedState
      if (projectStates) projectStates.push(suspendedState)

      throw new OError(
        'Cannot resolve unique project name after 100 attempts',
        {
          userId,
          folderName: file.name,
          folderId: file.id,
        }
      )
    }
  }

  const newProject = await ProjectCreationHandler.promises.createBlankProject(
    userId,
    resolvedProjectName
  )

  const newState = {
    projectId: newProject._id,
    userId: userObjectId,
    driveFolderId: file.id,
    folderName: file.name,
    fileMap: {},
    folderMap: {},
    syncStatus: 'idle',
    lastSyncedAt: new Date(),
  }
  await db.googleDriveProjectStates.insertOne(newState)
  if (projectByFolderId) projectByFolderId[file.id] = newState
  if (folderMap) folderMap[file.id] = { state: newState, relativePath: '' }
  if (projectStates) projectStates.push(newState)

  try {
    await syncProject(newProject._id, userId, file.id)
  } catch (syncErr) {
    logger.warn(
      { syncErr, projectId: newProject._id },
      'Error during initial sync of newly created project from Google Drive'
    )
  }

  return newState
}

/**
 * Actively lists the current direct subfolders of a user's root Google Drive
 * folder and creates a matching Overleaf project for any that aren't linked
 * to a known project yet. If an existing project is already linked, it syncs
 * it to ensure any pending or modified remote files are imported.
 *
 * Unlike pollUserChanges, which only reacts to live Changes API events and
 * so never sees folders that already existed before the account was linked
 * (or before the polling cursor started), this actively enumerates the
 * folder's current contents via files.list - so pre-existing project
 * folders in Drive are picked up too. Intended to run once right after
 * linking, and on-demand via a "Scan for existing projects" action.
 *
 * @param {string|ObjectId} userId
 * @param {object} [options]
 * @param {boolean} [options.syncExisting=true] Whether to run sync on already-linked projects
 * @returns {Promise<{scannedCount: number, createdCount: number, createdProjects: Array<{projectId: ObjectId, name: string}>, syncedCount: number, syncedProjects: Array<{projectId: ObjectId, name: string}>}>}
 */
async function reconcileExistingDriveProjects(userId, options = {}) {
  const syncExisting = options.syncExisting ?? true
  const userObjectId = _toObjectId(userId)
  const rootFolderId = await GoogleDriveClient.getOrCreateRootFolder(userId)

  const projectStates = await db.googleDriveProjectStates
    .find({ userId: userObjectId })
    .toArray()

  const projectByFolderId = {}
  const folderMap = {}
  for (const st of projectStates) {
    if (st.driveFolderId) {
      projectByFolderId[st.driveFolderId] = st
      folderMap[st.driveFolderId] = { state: st, relativePath: '' }
    }
  }

  const query = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${rootFolderId}' in parents`
  const fields = 'files(id,name,trashed),nextPageToken'

  let scannedCount = 0
  const createdProjects = []
  const syncedProjects = []
  let pageToken = null

  do {
    const res = await GoogleDriveClient.listFiles(
      userId,
      query,
      fields,
      pageToken
    )
    const files = res?.files || []
    scannedCount += files.length

    for (const file of files) {
      const existingState =
        projectByFolderId[file.id] ||
        projectStates.find(s => s.folderName === file.name)
      if (existingState) {
        if (syncExisting) {
          try {
            await syncProject(
              existingState.projectId,
              userId,
              existingState.driveFolderId || file.id
            )
            syncedProjects.push({
              projectId: existingState.projectId,
              name: existingState.folderName || file.name,
            })
          } catch (syncErr) {
            logger.warn(
              { syncErr, projectId: existingState.projectId },
              'Error syncing existing project during reconcileExistingDriveProjects'
            )
          }
        }
        continue
      }

      const newState = await _createProjectFromDriveFolder(
        userId,
        userObjectId,
        file,
        projectByFolderId,
        folderMap,
        projectStates
      )
      createdProjects.push({
        projectId: newState.projectId,
        name: newState.folderName,
      })
    }

    pageToken = res?.nextPageToken || null
  } while (pageToken)

  return {
    scannedCount,
    createdCount: createdProjects.length,
    createdProjects,
    syncedCount: syncedProjects.length,
    syncedProjects,
  }
}

/**
 * Polls incremental Google Drive changes for a user and applies them across affected projects.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<{ success?: boolean, unlinked?: boolean, initialized?: boolean, processedCount?: number, startPageToken?: string, newStartPageToken?: string }>}
 */
async function pollUserChanges(userId) {
  const userObjectId = _toObjectId(userId)
  const creds = await db.googleDriveUserCredentials.findOne({
    user_id: userObjectId,
  })

  if (!creds) {
    return { unlinked: true }
  }

  const rootFolderId =
    creds.rootFolderId ||
    (await GoogleDriveClient.getOrCreateRootFolder(userId))

  let pageToken = creds.startPageToken
  if (!pageToken) {
    pageToken = await GoogleDriveClient.getStartPageToken(userId)
    return { initialized: true, startPageToken: pageToken }
  }

  const allChanges = []
  let currentPageToken = pageToken
  let newStartPageToken = null

  while (currentPageToken) {
    const res = await GoogleDriveClient.getChanges(userId, currentPageToken)
    if (res.changes && res.changes.length > 0) {
      allChanges.push(...res.changes)
    }
    if (res.nextPageToken) {
      currentPageToken = res.nextPageToken
    } else {
      newStartPageToken = res.newStartPageToken
      break
    }
  }

  if (allChanges.length === 0) {
    if (newStartPageToken && newStartPageToken !== pageToken) {
      await db.googleDriveUserCredentials.updateOne(
        { user_id: userObjectId },
        {
          $set: {
            startPageToken: newStartPageToken,
            updatedAt: new Date(),
          },
        }
      )
    }
    return { success: true, processedCount: 0, newStartPageToken }
  }

  const projectStates = await db.googleDriveProjectStates
    .find({ userId: userObjectId })
    .toArray()

  const projectByFolderId = {}
  const projectByFileId = {}
  const folderMap = {}

  for (const st of projectStates) {
    if (st.driveFolderId) {
      projectByFolderId[st.driveFolderId] = st
      folderMap[st.driveFolderId] = { state: st, relativePath: '' }
    }
    if (st.folderMap) {
      for (const [subFolderId, relFolderPath] of Object.entries(st.folderMap)) {
        folderMap[subFolderId] = { state: st, relativePath: relFolderPath }
      }
    }
    if (st.fileMap) {
      for (const [p, fInfo] of Object.entries(st.fileMap)) {
        if (fInfo?.driveFileId) {
          projectByFileId[fInfo.driveFileId] = {
            state: st,
            path: p,
            info: fInfo,
          }
        }
      }
    }
  }

  for (const change of allChanges) {
    const fileId = change.fileId
    const isRemoved = change.removed === true || change.file?.trashed === true
    const file = change.file

    // Case 1: Folder change in Google Drive
    if (file && file.mimeType === 'application/vnd.google-apps.folder') {
      const isDirectChildOfRoot = file.parents?.includes(rootFolderId)

      if (isDirectChildOfRoot) {
        if (!isRemoved) {
          const existingState =
            projectByFolderId[file.id] ||
            projectStates.find(s => s.folderName === file.name)
          if (!existingState) {
            await _createProjectFromDriveFolder(
              userId,
              userObjectId,
              file,
              projectByFolderId,
              folderMap,
              projectStates
            )
            continue
          }
        } else {
          // Project folder removed / trashed in Drive
          const st = projectByFolderId[fileId]
          if (st) {
            logger.info(
              { projectId: st.projectId, userId },
              'Google Drive project folder deleted: clearing Overleaf entities while preserving project'
            )
            try {
              const entities =
                await ProjectEntityHandler.promises.getAllEntities(st.projectId)
              for (const doc of entities.docs || []) {
                await EditorController.promises.deleteEntityWithPath(
                  st.projectId,
                  doc.path,
                  'google-drive',
                  userId
                )
              }
              for (const f of entities.files || []) {
                await EditorController.promises.deleteEntityWithPath(
                  st.projectId,
                  f.path,
                  'google-drive',
                  userId
                )
              }
              await db.googleDriveProjectStates.updateOne(
                { projectId: st.projectId },
                {
                  $set: {
                    fileMap: {},
                    folderMap: {},
                    lastSyncedAt: new Date(),
                  },
                }
              )
            } catch (delErr) {
              logger.warn(
                { delErr, projectId: st.projectId },
                'Error cleaning up deleted project entities'
              )
            }
            continue
          }
        }
      } else if (!isRemoved && file.parents && file.parents.length > 0) {
        // Nested subfolder added in Google Drive
        const parentFolderEntry = await resolveDriveFolderHierarchy(
          userId,
          file.parents[0],
          rootFolderId,
          projectStates,
          folderMap
        )
        if (parentFolderEntry && parentFolderEntry.state) {
          const relPath = parentFolderEntry.relativePath
            ? `${parentFolderEntry.relativePath}/${file.name}`
            : file.name
          folderMap[file.id] = {
            state: parentFolderEntry.state,
            relativePath: relPath,
          }
          try {
            await db.googleDriveProjectStates.updateOne(
              { projectId: _toObjectId(parentFolderEntry.state.projectId) },
              { $set: { [`folderMap.${file.id}`]: relPath } }
            )
          } catch {}
        }
      }
    }

    // Case 2: File removed
    if (isRemoved) {
      const mapping = projectByFileId[fileId]
      if (mapping) {
        const { state: st, path: filePath } = mapping
        if (!isIgnoredFile(filePath)) {
          logger.info(
            { projectId: st.projectId, filePath, fileId },
            'Deleting Overleaf entity due to Google Drive file deletion'
          )
          try {
            await EditorController.promises.deleteEntityWithPath(
              st.projectId,
              toElementPath(filePath),
              'google-drive',
              userId
            )
            const updatedMap = { ...(st.fileMap || {}) }
            delete updatedMap[filePath]
            st.fileMap = updatedMap
            delete projectByFileId[fileId]
            await db.googleDriveProjectStates.updateOne(
              { projectId: st.projectId },
              { $set: { fileMap: updatedMap, lastSyncedAt: new Date() } }
            )
          } catch (err) {
            logger.warn(
              { err, projectId: st.projectId, filePath },
              'Error deleting entity'
            )
          }
        }
      }
      continue
    }

    // Case 3: File modified / created in Drive
    if (file && file.mimeType !== 'application/vnd.google-apps.folder') {
      let targetState = null
      let relativePath = null

      if (file.parents && file.parents.length > 0) {
        for (const parentId of file.parents) {
          const folderEntry = await resolveDriveFolderHierarchy(
            userId,
            parentId,
            rootFolderId,
            projectStates,
            folderMap
          )
          if (folderEntry && folderEntry.state) {
            targetState = folderEntry.state
            relativePath = folderEntry.relativePath
              ? `${folderEntry.relativePath}/${file.name}`
              : file.name
            break
          }
        }
      }

      const mapping = projectByFileId[file.id]
      if (!targetState && mapping) {
        targetState = mapping.state
        if (file.name) {
          const oldDir = path.posix.dirname(mapping.path)
          relativePath = oldDir === '.' ? file.name : `${oldDir}/${file.name}`
        } else {
          relativePath = mapping.path
        }
      }

      if (!targetState || !relativePath) {
        continue
      }

      const cleanPath = normalizePath(relativePath)
      if (isIgnoredFile(cleanPath)) {
        continue
      }

      const projectId = targetState.projectId

      // Handle rename or move for a known Drive file ID
      if (mapping && normalizePath(mapping.path) !== cleanPath) {
        const oldPath = normalizePath(mapping.path)
        const oldState = mapping.state
        const oldInfo = mapping.info || oldState.fileMap?.[oldPath] || {}

        let entityId = oldInfo.entityId
        let entityType = oldInfo.entityType

        if (!entityId || !entityType) {
          try {
            const entities =
              await ProjectEntityHandler.promises.getAllEntities(projectId)
            const docEntry = (entities.docs || []).find(
              d => normalizePath(d.path) === oldPath
            )
            if (docEntry) {
              entityId = docEntry.doc?._id
              entityType = 'doc'
            } else {
              const fileEntry = (entities.files || []).find(
                f => normalizePath(f.path) === oldPath
              )
              if (fileEntry) {
                entityId = fileEntry.file?._id
                entityType = 'file'
              }
            }
          } catch (entityLookupErr) {
            logger.debug(
              { entityLookupErr, oldPath, projectId },
              'Could not lookup entity during rename/move'
            )
          }
        }

        if (!entityType) {
          entityType = isBinaryFile(oldPath, file.mimeType) ? 'file' : 'doc'
        }

        const oldDir = path.posix.dirname(oldPath)
        const newDir = path.posix.dirname(cleanPath)
        const oldName = path.posix.basename(oldPath)
        const newName = path.posix.basename(cleanPath)

        if (oldDir !== newDir) {
          const newFolderId = await _ensureFolderPathInOverleaf(
            projectId,
            newDir,
            userId
          )
          logger.info(
            { projectId, entityId, oldPath, cleanPath, newFolderId },
            'Moving Overleaf entity by stable Drive file ID'
          )
          await EditorController.promises.moveEntity(
            projectId,
            entityId,
            newFolderId,
            entityType,
            userId,
            'google-drive'
          )
        }

        if (oldName !== newName) {
          logger.info(
            { projectId, entityId, oldPath, cleanPath, newName },
            'Renaming Overleaf entity by stable Drive file ID'
          )
          await EditorController.promises.renameEntity(
            projectId,
            entityId,
            entityType,
            newName,
            userId,
            'google-drive'
          )
        }

        const updatedFileMap = { ...(oldState.fileMap || {}) }
        delete updatedFileMap[oldPath]
        const updatedEntry = {
          ...oldInfo,
          driveFileId: file.id,
          entityId,
          entityType,
          md5Checksum: oldInfo.md5Checksum,
          modifiedTime: file.modifiedTime
            ? new Date(file.modifiedTime)
            : oldInfo.modifiedTime || new Date(),
        }
        updatedFileMap[cleanPath] = updatedEntry
        oldState.fileMap = updatedFileMap
        if (targetState !== oldState) {
          targetState.fileMap = {
            ...(targetState.fileMap || {}),
            [cleanPath]: updatedEntry,
          }
        }

        mapping.path = cleanPath
        mapping.info = updatedEntry
        mapping.state = targetState

        await db.googleDriveProjectStates.updateOne(
          { projectId: _toObjectId(oldState.projectId) },
          { $set: { fileMap: updatedFileMap, lastSyncedAt: new Date() } }
        )
        if (
          targetState !== oldState &&
          targetState.projectId !== oldState.projectId
        ) {
          await db.googleDriveProjectStates.updateOne(
            { projectId: _toObjectId(targetState.projectId) },
            {
              $set: { fileMap: targetState.fileMap, lastSyncedAt: new Date() },
            }
          )
        }
      }

      // The Changes API reports a real change regardless of who caused it -
      // including our own outbound pushes to Drive. If this file's checksum
      // already matches what we last recorded, it's already fully
      // reflected in our state (either we already pulled it, or we're the
      // ones who just wrote it), so there's nothing new to do. Without this
      // check, every self-caused Drive write loops back through here on
      // the next poll and gets needlessly re-fetched - and, if Overleaf's
      // rev happens to have moved on since, misclassified as a concurrent
      // edit conflict.
      const lastMappedForFile = targetState.fileMap?.[cleanPath]
      if (
        file.md5Checksum &&
        lastMappedForFile?.md5Checksum &&
        file.md5Checksum === lastMappedForFile.md5Checksum
      ) {
        continue
      }

      let ovEntity = null
      try {
        const allDocs = await DocstoreManager.promises.getAllDocs(projectId)
        const entities =
          await ProjectEntityHandler.promises.getAllEntities(projectId)
        const docEntry = (entities.docs || []).find(
          d => normalizePath(d.path) === cleanPath
        )
        if (docEntry) {
          const docContent = (allDocs || []).find(
            d => d._id?.toString() === docEntry.doc?._id?.toString()
          )
          ovEntity = {
            type: 'doc',
            id: docEntry.doc?._id,
            lines: docContent?.lines || [],
            rev: docContent?.rev ?? 0,
          }
        } else {
          const fileEntry = (entities.files || []).find(
            f => normalizePath(f.path) === cleanPath
          )
          if (fileEntry) {
            ovEntity = {
              type: 'file',
              id: fileEntry.file?._id,
              hash: fileEntry.file?.hash,
            }
          }
        }
      } catch (checkErr) {
        logger.debug(
          { checkErr },
          'Could not check entity conflict state in pollUserChanges'
        )
      }

      const mapped = lastMappedForFile
      const driveChanged =
        !mapped?.md5Checksum ||
        (file.md5Checksum && file.md5Checksum !== mapped.md5Checksum) ||
        !file.md5Checksum

      let localChanged = false
      if (ovEntity) {
        if (ovEntity.type === 'doc') {
          if (mapped && mapped.rev !== undefined) {
            localChanged = ovEntity.rev !== mapped.rev
          } else if (mapped?.md5Checksum) {
            const lines = ovEntity.lines || []
            const content = Array.isArray(lines)
              ? lines.join('\n')
              : lines || ''
            const localHash = crypto
              .createHash('md5')
              .update(Buffer.from(content, 'utf8'))
              .digest('hex')
            localChanged = localHash !== mapped.md5Checksum
          }
        } else if (ovEntity.hash) {
          if (mapped?.overleafHash !== undefined) {
            localChanged = ovEntity.hash !== mapped.overleafHash
          } else if (mapped?.md5Checksum !== undefined) {
            localChanged = ovEntity.hash !== mapped.md5Checksum
          }
        }
      }

      if (driveChanged && localChanged) {
        const conflictPath = generateConflictPath(cleanPath)
        logger.warn(
          { projectId, path: cleanPath, conflictPath },
          'GoogleDriveSync: conflict detected, creating conflict copy'
        )

        if (isBinaryFile(cleanPath, file.mimeType)) {
          const tempDir = process.env.TMPDIR || os.tmpdir()
          const tempFilePath = path.join(
            tempDir,
            `gdrive_sync_${crypto.randomBytes(8).toString('hex')}_${path.basename(conflictPath)}`
          )
          try {
            const driveBuffer = await GoogleDriveClient.downloadFileBuffer(
              userId,
              file.id
            )
            await fs.promises.writeFile(tempFilePath, driveBuffer)
            await EditorController.promises.upsertFileWithPath(
              projectId,
              toElementPath(conflictPath),
              tempFilePath,
              null,
              'google-drive',
              userId
            )
          } catch (err) {
            logger.warn(
              { err, projectId, conflictPath },
              'Error upserting binary conflict file from Google Drive'
            )
          } finally {
            try {
              await fs.promises.unlink(tempFilePath)
            } catch {}
          }
        } else {
          try {
            const driveBuffer = await GoogleDriveClient.downloadFileBuffer(
              userId,
              file.id
            )
            const driveContent = driveBuffer.toString('utf8')
            const driveLines = driveContent.split('\n')
            await EditorController.promises.upsertDocWithPath(
              projectId,
              toElementPath(conflictPath),
              driveLines,
              'google-drive',
              userId
            )
          } catch (err) {
            logger.warn(
              { err, projectId, conflictPath },
              'Error upserting doc conflict file from Google Drive'
            )
          }
        }

        const conflictRecord = {
          path: cleanPath,
          conflictPath,
          detectedAt: new Date(),
        }
        await db.googleDriveProjectStates.updateOne(
          { projectId: _toObjectId(projectId) },
          {
            $push: {
              conflicts: {
                $each: [conflictRecord],
                $slice: -20,
              },
            },
          }
        )

        const updatedMap = {
          ...(targetState.fileMap || {}),
          [cleanPath]: {
            driveFileId: file.id,
            md5Checksum: file.md5Checksum,
            modifiedTime: file.modifiedTime
              ? new Date(file.modifiedTime)
              : new Date(),
            rev:
              ovEntity?.type === 'doc'
                ? (lastMappedForFile?.rev ?? ovEntity.rev)
                : null,
            entityId: ovEntity?.id || lastMappedForFile?.entityId,
            entityType:
              ovEntity?.type ||
              (isBinaryFile(cleanPath, file.mimeType) ? 'file' : 'doc'),
            ...(ovEntity?.hash ? { overleafHash: ovEntity.hash } : {}),
          },
        }
        targetState.fileMap = updatedMap
        projectByFileId[file.id] = {
          state: targetState,
          path: cleanPath,
          info: updatedMap[cleanPath],
        }
        await db.googleDriveProjectStates.updateOne(
          { projectId: _toObjectId(projectId) },
          { $set: { fileMap: updatedMap, lastSyncedAt: new Date() } }
        )
      } else if (isBinaryFile(cleanPath, file.mimeType)) {
        const tempDir = process.env.TMPDIR || os.tmpdir()
        const tempFilePath = path.join(
          tempDir,
          `gdrive_sync_${crypto.randomBytes(8).toString('hex')}_${path.basename(cleanPath)}`
        )
        let upsertRes = null
        try {
          const driveBuffer = await GoogleDriveClient.downloadFileBuffer(
            userId,
            file.id
          )
          await fs.promises.writeFile(tempFilePath, driveBuffer)
          upsertRes = await EditorController.promises.upsertFileWithPath(
            projectId,
            toElementPath(cleanPath),
            tempFilePath,
            null,
            'google-drive',
            userId
          )
        } catch (err) {
          logger.warn(
            { err, projectId, cleanPath },
            'Error upserting binary file from Google Drive'
          )
        } finally {
          try {
            await fs.promises.unlink(tempFilePath)
          } catch {}
        }

        const updatedMap = {
          ...(targetState.fileMap || {}),
          [cleanPath]: {
            driveFileId: file.id,
            md5Checksum: file.md5Checksum,
            modifiedTime: file.modifiedTime
              ? new Date(file.modifiedTime)
              : new Date(),
            rev: null,
            entityId:
              upsertRes?.file?._id ||
              upsertRes?._id ||
              ovEntity?.id ||
              mapped?.entityId,
            entityType: 'file',
          },
        }
        targetState.fileMap = updatedMap
        projectByFileId[file.id] = {
          state: targetState,
          path: cleanPath,
          info: updatedMap[cleanPath],
        }
        await db.googleDriveProjectStates.updateOne(
          { projectId: _toObjectId(projectId) },
          { $set: { fileMap: updatedMap, lastSyncedAt: new Date() } }
        )
      } else {
        try {
          const driveBuffer = await GoogleDriveClient.downloadFileBuffer(
            userId,
            file.id
          )
          const driveContent = driveBuffer.toString('utf8')
          const driveLines = driveContent.split('\n')

          const upsertRes = await EditorController.promises.upsertDocWithPath(
            projectId,
            toElementPath(cleanPath),
            driveLines,
            'google-drive',
            userId
          )
          const updatedRev =
            upsertRes?.doc?.rev ??
            upsertRes?.rev ??
            (mapped?.rev !== undefined ? mapped.rev + 1 : 0)

          const updatedMap = {
            ...(targetState.fileMap || {}),
            [cleanPath]: {
              driveFileId: file.id,
              md5Checksum: file.md5Checksum,
              modifiedTime: file.modifiedTime
                ? new Date(file.modifiedTime)
                : new Date(),
              rev: updatedRev,
              entityId:
                upsertRes?.doc?._id ||
                upsertRes?._id ||
                ovEntity?.id ||
                mapped?.entityId,
              entityType: 'doc',
            },
          }
          targetState.fileMap = updatedMap
          projectByFileId[file.id] = {
            state: targetState,
            path: cleanPath,
            info: updatedMap[cleanPath],
          }
          await db.googleDriveProjectStates.updateOne(
            { projectId: _toObjectId(projectId) },
            { $set: { fileMap: updatedMap, lastSyncedAt: new Date() } }
          )
        } catch (err) {
          logger.warn(
            { err, projectId, cleanPath },
            'Error upserting doc from Google Drive'
          )
        }
      }
    }
  }

  if (newStartPageToken) {
    await db.googleDriveUserCredentials.updateOne(
      { user_id: userObjectId },
      {
        $set: {
          startPageToken: newStartPageToken,
          updatedAt: new Date(),
        },
      }
    )
  }

  return {
    success: true,
    processedCount: allChanges.length,
    newStartPageToken,
  }
}

/**
 * Returns the current synchronization status for an Overleaf project.
 *
 * @param {string|ObjectId} projectId
 * @returns {Promise<{ linked: boolean, driveFolderId?: string, folderName?: string, syncStatus: string, lastSyncedAt?: Date|null, lastError?: string|null, isSyncing: boolean, fileCount: number }>}
 */
async function getProjectStatus(projectId, userId) {
  // Whether Google Drive is linked at all is an account-level property
  // (googleDriveUserCredentials), not something recorded per-project. A
  // project only gets a googleDriveProjectStates document once it has been
  // synced at least once, so a missing state must not be reported as
  // "unlinked" when the user's account is in fact linked - otherwise the
  // "Sync this project now" action (which is what creates that first state
  // document) can never be reached, because the UI disables it whenever
  // linked is false.
  let accountLinked = true
  if (userId) {
    const linkStatus = await GoogleDriveOAuthManager.isLinked(userId)
    accountLinked = Boolean(linkStatus?.isLinked)
  }

  const projectObjectId = _toObjectId(projectId)
  const state = await db.googleDriveProjectStates.findOne({
    projectId: projectObjectId,
  })

  if (!accountLinked) {
    return {
      linked: false,
      syncStatus: 'unlinked',
      isSyncing: false,
      fileCount: 0,
    }
  }

  if (!state) {
    // Account is linked, but this project has never been synced yet.
    return { linked: true, syncStatus: 'idle', isSyncing: false, fileCount: 0 }
  }

  return {
    linked: true,
    driveFolderId: state.driveFolderId || null,
    folderName: state.folderName || null,
    syncStatus: state.syncStatus || 'idle',
    lastSyncedAt: state.lastSyncedAt || null,
    lastManualSyncAt: state.lastManualSyncAt || null,
    lastError: state.lastError || null,
    isSyncing: Boolean(state.isSyncing),
    fileCount: state.fileMap ? Object.keys(state.fileMap).length : 0,
    ...(state.syncSuspended !== undefined
      ? { syncSuspended: Boolean(state.syncSuspended) }
      : {}),
    ...(state.suspendReason ? { suspendReason: state.suspendReason } : {}),
    ...(state.conflicts ? { conflicts: state.conflicts } : {}),
  }
}

const GoogleDriveSyncManager = {
  isIgnoredFile,
  isBinaryFile,
  generateConflictPath,
  normalizePath,
  encodePathKey,
  decodePathKey,
  recordSyncFailure,
  clearSyncFailure,
  acquireProjectLock,
  releaseProjectLock,
  enforceManualSyncCooldown,
  handleOutboundDocUpdate,
  handleOutboundFileUpdate,
  handleOutboundDelete,
  syncProject,
  pollUserChanges,
  reconcileExistingDriveProjects,
  getProjectStatus,
  resolveDriveFolderHierarchy,
  _ensureFolderPathInOverleaf,
  getOrCreateProjectFolder,
  _createProjectFromDriveFolder,
}

export default GoogleDriveSyncManager
export {
  isIgnoredFile,
  isBinaryFile,
  generateConflictPath,
  normalizePath,
  encodePathKey,
  decodePathKey,
  recordSyncFailure,
  clearSyncFailure,
  acquireProjectLock,
  releaseProjectLock,
  enforceManualSyncCooldown,
  handleOutboundDocUpdate,
  handleOutboundFileUpdate,
  handleOutboundDelete,
  syncProject,
  pollUserChanges,
  reconcileExistingDriveProjects,
  getProjectStatus,
  resolveDriveFolderHierarchy,
  _ensureFolderPathInOverleaf,
  getOrCreateProjectFolder,
  _createProjectFromDriveFolder,
}
