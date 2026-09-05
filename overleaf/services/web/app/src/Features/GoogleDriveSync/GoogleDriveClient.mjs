import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { fetchJson, fetchNothing, fetchStream } from '@overleaf/fetch-utils'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import GoogleDriveOAuthManager from './GoogleDriveOAuthManager.mjs'
import GoogleDriveRateLimiter from './GoogleDriveRateLimiter.mjs'

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'

const DEFAULT_RETRY_CONFIG = {
  maxRetries: 5,
  initialDelayMs: 100,
  backoffFactor: 2,
  maxDelayMs: 32000,
}

// 403 reasons that mean "slow down" rather than "you may not do this".
// Anything else with a 403 is permanent, and retrying it only burns quota.
const RATE_LIMIT_403_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
])

/**
 * Extracts Google's machine-readable error reason from a failed request.
 *
 * @param {any} err
 * @returns {string|null}
 */
function _driveErrorReason(err) {
  const body = err.body ?? err.response?.body ?? err.info?.body
  return body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null
}

/**
 * True when the failure is Google asking us to back off.
 *
 * @param {number|null} status
 * @param {any} err
 * @returns {boolean}
 */
function _isRateLimitError(status, err) {
  if (status === 429) return true
  if (status === 403) {
    return RATE_LIMIT_403_REASONS.has(_driveErrorReason(err))
  }
  return false
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
 * Escapes characters in search strings for Google Drive API queries.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeQueryString(str) {
  if (!str) return ''
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Reads a Node.js Stream, Buffer, or string and returns a Buffer.
 *
 * @param {import('node:stream').Readable|Buffer|string} streamOrBuffer
 * @returns {Promise<Buffer>}
 */
async function streamToBuffer(streamOrBuffer) {
  if (!streamOrBuffer) return Buffer.alloc(0)
  if (Buffer.isBuffer(streamOrBuffer)) return streamOrBuffer
  if (typeof streamOrBuffer === 'string')
    return Buffer.from(streamOrBuffer, 'utf8')
  if (
    typeof streamOrBuffer[Symbol.asyncIterator] === 'function' ||
    typeof streamOrBuffer.on === 'function'
  ) {
    const chunks = []
    for await (const chunk of streamOrBuffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }
  return Buffer.from(streamOrBuffer)
}

/**
 * Constructs a multipart/related body buffer for Google Drive file uploads.
 *
 * @param {object} metadata
 * @param {Buffer} fileBuffer
 * @param {string} [mimeType]
 * @returns {{ boundary: string, bodyBuffer: Buffer, contentType: string }}
 */
function buildMultipartBody(
  metadata,
  fileBuffer,
  mimeType = 'application/octet-stream'
) {
  const boundary = `-------overleaf_gdrive_${crypto.randomBytes(16).toString('hex')}`
  const delimiter = `\r\n--${boundary}\r\n`
  const closeDelimiter = `\r\n--${boundary}--`

  const metadataPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`
  const mediaHeader = `${delimiter}Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`

  const bodyBuffer = Buffer.concat([
    Buffer.from(metadataPart, 'utf8'),
    Buffer.from(mediaHeader, 'utf8'),
    fileBuffer,
    Buffer.from(closeDelimiter, 'utf8'),
  ])

  return {
    boundary,
    bodyBuffer,
    contentType: `multipart/related; boundary=${boundary}`,
  }
}

/**
 * Executes an asynchronous request function with exponential backoff retry for
 * transient network or rate-limiting errors (429, 5xx, ECONNRESET, etc.).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [options]
 * @returns {Promise<T>}
 */
async function _requestWithRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries
  const initialDelayMs =
    options.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs
  const backoffFactor =
    options.backoffFactor ?? DEFAULT_RETRY_CONFIG.backoffFactor
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs

  let attempt = 0
  let delay = initialDelayMs

  while (true) {
    try {
      await GoogleDriveRateLimiter.acquire()
      return await fn()
    } catch (err) {
      attempt++
      const status =
        err.response?.status ??
        err.info?.status ??
        err.status ??
        (typeof err.statusCode === 'number' ? err.statusCode : null)

      const rateLimited = _isRateLimitError(status, err)

      const isRetryable =
        rateLimited ||
        (status >= 500 && status <= 599) ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'EAI_AGAIN'

      if (!isRetryable || attempt > maxRetries) {
        if (rateLimited) {
          err.rateLimited = true
        }
        throw err
      }

      let waitTime = delay + Math.random() * (delay * 0.2)
      let retryAfterHeader = null

      if (err.response?.headers) {
        if (typeof err.response.headers.get === 'function') {
          retryAfterHeader = err.response.headers.get('Retry-After')
        } else if (err.response.headers instanceof Map) {
          retryAfterHeader = err.response.headers.get('Retry-After')
        } else if (typeof err.response.headers === 'object') {
          retryAfterHeader =
            err.response.headers['retry-after'] ||
            err.response.headers['Retry-After']
        }
      }

      if (retryAfterHeader) {
        const parsedSeconds = parseInt(retryAfterHeader, 10)
        if (!isNaN(parsedSeconds)) {
          waitTime = parsedSeconds * 1000
        }
      }

      logger.warn(
        { attempt, maxRetries, waitTime, status, err: err.message },
        'Retrying Google Drive API request'
      )

      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime))
      }
      delay = Math.min(delay * backoffFactor, maxDelayMs)
    }
  }
}

/**
 * Finds or creates the dedicated Overleaf root folder in Google Drive and caches its ID.
 *
 * @param {string|ObjectId} userId
 * @param {string} [folderName]
 * @returns {Promise<string>} Google Drive Folder ID
 */
async function getOrCreateRootFolder(userId, folderName) {
  const userObjectId = _toObjectId(userId)

  // If credentials already record a valid root folder, reuse it directly
  if (!folderName) {
    try {
      const creds = await db.googleDriveUserCredentials.findOne({
        user_id: userObjectId,
      })
      if (creds?.rootFolderId) {
        const meta = await getFileMetadata(
          userId,
          creds.rootFolderId,
          'id,name,trashed'
        )
        if (meta && !meta.trashed) {
          return creds.rootFolderId
        }
      }
    } catch {
      // If verification fails or folder was deleted, fall through to lookup/create
    }
  }

  const name = folderName || Settings.googleDrive?.folderName || 'Overleaf'
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)

  const escapedName = escapeQueryString(name)
  const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and trashed = false and 'root' in parents`
  const queryUrl = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,trashed)`

  const listResponse = await _requestWithRetry(() =>
    fetchJson(queryUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )

  let rootFolderId = null
  if (listResponse?.files && listResponse.files.length > 0) {
    rootFolderId = listResponse.files[0].id
  } else {
    const createUrl = `${DRIVE_API_BASE}/files`
    const createResponse = await _requestWithRetry(() =>
      fetchJson(createUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        json: {
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['root'],
        },
      })
    )
    rootFolderId = createResponse.id
  }

  await db.googleDriveUserCredentials.updateOne(
    { user_id: userObjectId },
    {
      $set: {
        rootFolderId,
        updatedAt: new Date(),
      },
    }
  )

  return rootFolderId
}

/**
 * Finds or creates a subfolder within a parent Google Drive folder.
 *
 * @param {string|ObjectId} userId
 * @param {string} parentFolderId
 * @param {string} subfolderName
 * @returns {Promise<string>} Google Drive Folder ID
 */
async function getOrCreateSubfolder(userId, parentFolderId, subfolderName) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)

  const escapedName = escapeQueryString(subfolderName)
  const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and '${parentFolderId}' in parents and trashed = false`
  const queryUrl = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,trashed)`

  const listResponse = await _requestWithRetry(() =>
    fetchJson(queryUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )

  if (listResponse?.files && listResponse.files.length > 0) {
    return listResponse.files[0].id
  }

  const createUrl = `${DRIVE_API_BASE}/files`
  const createResponse = await _requestWithRetry(() =>
    fetchJson(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      json: {
        name: subfolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId],
      },
    })
  )

  return createResponse.id
}

/**
 * Finds or creates the project folder inside the root Overleaf folder.
 *
 * @param {string|ObjectId} userId
 * @param {string} rootFolderId
 * @param {string} projectName
 * @returns {Promise<string>} Google Drive Folder ID
 */
async function getOrCreateProjectFolder(userId, rootFolderId, projectName) {
  return getOrCreateSubfolder(userId, rootFolderId, projectName)
}

/**
 * Uploads a file (create new or update existing) using Google Drive multipart upload.
 *
 * @param {string|ObjectId} userId
 * @param {string} [parentFolderId]
 * @param {string} fileName
 * @param {import('node:stream').Readable|Buffer|string} contentStreamOrBuffer
 * @param {string} [mimeType='text/plain']
 * @param {string} [existingFileId=null]
 * @returns {Promise<{ id: string, name: string, md5Checksum: string, modifiedTime: string, size: string, mimeType: string }>}
 */
async function uploadFile(
  userId,
  parentFolderId,
  fileName,
  contentStreamOrBuffer,
  mimeType = 'text/plain',
  existingFileId = null
) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  const fileBuffer = await streamToBuffer(contentStreamOrBuffer)

  const metadata = {
    name: fileName,
    mimeType: mimeType || 'text/plain',
  }

  if (!existingFileId && parentFolderId) {
    metadata.parents = [parentFolderId]
  }

  const { bodyBuffer, contentType } = buildMultipartBody(
    metadata,
    fileBuffer,
    mimeType
  )

  const fields = 'id,name,md5Checksum,modifiedTime,size,mimeType'
  let url
  let method

  if (existingFileId) {
    url = `${DRIVE_UPLOAD_BASE}/files/${existingFileId}?uploadType=multipart&fields=${encodeURIComponent(fields)}`
    method = 'PATCH'
  } else {
    url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=${encodeURIComponent(fields)}`
    method = 'POST'
  }

  const response = await _requestWithRetry(() =>
    fetchJson(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': contentType,
        'Content-Length': String(bodyBuffer.length),
      },
      body: bodyBuffer,
    })
  )

  return response
}

/**
 * Downloads a file from Google Drive as a Readable stream.
 *
 * @param {string|ObjectId} userId
 * @param {string} fileId
 * @returns {Promise<import('node:stream').Readable>}
 */
async function downloadFile(userId, fileId) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media`

  const stream = await _requestWithRetry(() =>
    fetchStream(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )

  return stream
}

/**
 * Downloads a file from Google Drive and returns its contents as a Buffer.
 *
 * @param {string|ObjectId} userId
 * @param {string} fileId
 * @returns {Promise<Buffer>}
 */
async function downloadFileBuffer(userId, fileId) {
  const stream = await downloadFile(userId, fileId)
  return streamToBuffer(stream)
}

/**
 * Deletes a file or folder in Google Drive.
 *
 * @param {string|ObjectId} userId
 * @param {string} fileId
 * @returns {Promise<{ success: boolean }>}
 */
async function deleteFile(userId, fileId) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  const url = `${DRIVE_API_BASE}/files/${fileId}`

  await _requestWithRetry(() =>
    fetchNothing(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )

  return { success: true }
}

/**
 * Retrieves the current start page token for incremental change tracking.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<string>}
 */
async function getStartPageToken(userId) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  const url = `${DRIVE_API_BASE}/changes/startPageToken`

  const response = await _requestWithRetry(() =>
    fetchJson(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )

  const startPageToken = response.startPageToken

  if (startPageToken) {
    const userObjectId = _toObjectId(userId)
    await db.googleDriveUserCredentials.updateOne(
      { user_id: userObjectId },
      {
        $set: {
          startPageToken,
          updatedAt: new Date(),
        },
      }
    )
  }

  return startPageToken
}

/**
 * Fetches incremental changes starting from a page token.
 *
 * @param {string|ObjectId} userId
 * @param {string} pageToken
 * @returns {Promise<{ changes: Array<object>, nextPageToken: string|null, newStartPageToken: string|null }>}
 */
async function getChanges(userId, pageToken) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  const fields =
    'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,trashed,md5Checksum,modifiedTime))'
  const url = `${DRIVE_API_BASE}/changes?pageToken=${encodeURIComponent(pageToken)}&includeRemoved=true&fields=${encodeURIComponent(fields)}`

  const response = await _requestWithRetry(() =>
    fetchJson(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )

  return {
    changes: response.changes || [],
    nextPageToken: response.nextPageToken || null,
    newStartPageToken: response.newStartPageToken || null,
  }
}

/**
 * Fetches metadata for a specific Google Drive file.
 *
 * @param {string|ObjectId} userId
 * @param {string} fileId
 * @param {string} [fields]
 * @returns {Promise<object>}
 */
async function getFileMetadata(
  userId,
  fileId,
  fields = 'id,name,mimeType,parents,trashed,md5Checksum,modifiedTime,size'
) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  const url = `${DRIVE_API_BASE}/files/${fileId}?fields=${encodeURIComponent(fields)}`

  return _requestWithRetry(() =>
    fetchJson(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )
}

/**
 * Lists files matching a query.
 *
 * @param {string|ObjectId} userId
 * @param {string} query
 * @param {string} [fields]
 * @param {string} [pageToken]
 * @returns {Promise<{ files: Array<object>, nextPageToken?: string|null }>}
 */
async function listFiles(
  userId,
  query,
  fields = 'files(id,name,mimeType,parents,trashed,md5Checksum,modifiedTime,size),nextPageToken',
  pageToken = null
) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  let url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}`
  if (pageToken) {
    url += `&pageToken=${encodeURIComponent(pageToken)}`
  }

  return _requestWithRetry(() =>
    fetchJson(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )
}

/**
 * Sets up a watch channel for changes on Google Drive.
 *
 * @param {string|ObjectId} userId
 * @param {string} pageToken
 * @param {{ id: string, type: string, address: string, token?: string, expiration?: number }} channelData
 * @returns {Promise<object>} Google Drive channel response
 */
async function watchChanges(userId, pageToken, channelData) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  const url = `${DRIVE_API_BASE}/changes/watch?pageToken=${encodeURIComponent(pageToken)}`

  return _requestWithRetry(() =>
    fetchJson(url, {
      method: 'POST',
      json: channelData,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )
}

/**
 * Stops an active watch channel on Google Drive.
 *
 * @param {string|ObjectId} userId
 * @param {string} channelId
 * @param {string} resourceId
 * @returns {Promise<void>}
 */
async function stopChannel(userId, channelId, resourceId) {
  const accessToken = await GoogleDriveOAuthManager.getValidAccessToken(userId)
  const url = `${DRIVE_API_BASE}/channels/stop`

  return _requestWithRetry(() =>
    fetchNothing(url, {
      method: 'POST',
      json: {
        id: channelId,
        resourceId,
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  )
}

const GoogleDriveClient = {
  getOrCreateRootFolder,
  getOrCreateSubfolder,
  getOrCreateProjectFolder,
  uploadFile,
  downloadFile,
  downloadFileBuffer,
  deleteFile,
  getStartPageToken,
  getChanges,
  getFileMetadata,
  listFiles,
  watchChanges,
  stopChannel,
}

export default GoogleDriveClient
export {
  getOrCreateRootFolder,
  getOrCreateSubfolder,
  getOrCreateProjectFolder,
  uploadFile,
  downloadFile,
  downloadFileBuffer,
  deleteFile,
  getStartPageToken,
  getChanges,
  getFileMetadata,
  listFiles,
  watchChanges,
  stopChannel,
}
