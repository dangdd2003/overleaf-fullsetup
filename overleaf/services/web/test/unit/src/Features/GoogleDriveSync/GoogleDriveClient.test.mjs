import { describe, it, beforeEach, vi, expect } from 'vitest'
import { Readable } from 'node:stream'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs'

describe('GoogleDriveClient', function () {
  let GoogleDriveClient

  const userId = '60d5ecb8b392d40015b6d5a1'
  const validAccessToken = 'ya29.sample-valid-access-token-12345'
  const rootFolderId = 'gdrive-root-folder-id-111'
  const projectFolderId = 'gdrive-project-folder-id-222'

  const Settings = {
    googleDrive: {
      folderName: 'Overleaf',
    },
  }

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const db = {
    googleDriveUserCredentials: {
      findOne: vi.fn(),
      updateOne: vi.fn(),
    },
  }

  const GoogleDriveOAuthManager = {
    getValidAccessToken: vi.fn(),
  }

  const fetchUtils = {
    fetchJson: vi.fn(),
    fetchStream: vi.fn(),
    fetchNothing: vi.fn(),
  }

  class MockObjectId {
    constructor(id) {
      this.id = id
      this._bsontype = 'ObjectID'
    }
    toString() {
      return this.id.toString()
    }
    static isValid(id) {
      return typeof id === 'string' && id.length === 24
    }
  }

  class MockRequestFailedError extends Error {
    constructor(message, info, response, body) {
      super(message || 'request failed')
      this.name = 'RequestFailedError'
      this.info = info || {}
      this.response = response || {
        status: info?.status || 500,
        headers: new Map(),
      }
      this.body = body
    }
  }

  vi.doMock('@overleaf/settings', () => ({ default: Settings }))
  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('@overleaf/fetch-utils', () => ({
    ...fetchUtils,
    RequestFailedError: MockRequestFailedError,
  }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
    ObjectId: MockObjectId,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.mjs',
    () => ({
      default: GoogleDriveOAuthManager,
      ...GoogleDriveOAuthManager,
    })
  )

  const GoogleDriveRateLimiter = {
    acquire: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  }
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveRateLimiter.mjs',
    () => ({
      default: GoogleDriveRateLimiter,
      ...GoogleDriveRateLimiter,
    })
  )

  beforeEach(async function () {
    Settings.googleDrive = {
      folderName: 'Overleaf',
    }

    vi.clearAllMocks()
    db.googleDriveUserCredentials.findOne.mockReset()
    db.googleDriveUserCredentials.updateOne.mockReset()
    GoogleDriveOAuthManager.getValidAccessToken.mockReset()
    fetchUtils.fetchJson.mockReset()
    fetchUtils.fetchStream.mockReset()
    fetchUtils.fetchNothing.mockReset()

    GoogleDriveOAuthManager.getValidAccessToken.mockResolvedValue(
      validAccessToken
    )
    db.googleDriveUserCredentials.updateOne.mockResolvedValue({
      acknowledged: true,
    })

    GoogleDriveClient = (await import(modulePath)).default
  })

  describe('getOrCreateRootFolder', function () {
    it('reuses existing valid rootFolderId from credentials when present in DB', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        rootFolderId: 'cached-root-123',
      })
      fetchUtils.fetchJson.mockResolvedValue({
        id: 'cached-root-123',
        name: 'Overleaf',
        trashed: false,
      })

      const folderId = await GoogleDriveClient.getOrCreateRootFolder(userId)

      expect(folderId).toBe('cached-root-123')
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(1)
      expect(fetchUtils.fetchJson.mock.calls[0][0]).toContain('cached-root-123')
      expect(db.googleDriveUserCredentials.updateOne).not.toHaveBeenCalled()
    })

    it('returns existing root folder ID if found in Google Drive and updates DB', async function () {
      fetchUtils.fetchJson.mockResolvedValue({
        files: [{ id: rootFolderId, name: 'Overleaf' }],
      })

      const folderId = await GoogleDriveClient.getOrCreateRootFolder(
        userId,
        'Overleaf'
      )

      expect(folderId).toBe(rootFolderId)
      expect(GoogleDriveOAuthManager.getValidAccessToken).toHaveBeenCalledWith(
        userId
      )
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(1)

      const [url, opts] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toContain('https://www.googleapis.com/drive/v3/files')
      expect(url).toContain(
        encodeURIComponent(
          "mimeType = 'application/vnd.google-apps.folder' and name = 'Overleaf' and trashed = false and 'root' in parents"
        )
      )
      expect(opts.headers.Authorization).toBe(`Bearer ${validAccessToken}`)

      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledWith(
        { user_id: expect.anything() },
        {
          $set: {
            rootFolderId,
            updatedAt: expect.any(Date),
          },
        }
      )
    })

    it('creates root folder if not found in Google Drive, updates DB, and returns new folder ID', async function () {
      // First call: query returns empty
      // Second call: POST create returns new folder
      const createdFolderId = 'new-gdrive-root-folder-333'
      fetchUtils.fetchJson.mockImplementation(async (url, opts) => {
        if (opts.method === 'POST') {
          return {
            id: createdFolderId,
            name: 'Overleaf',
            mimeType: 'application/vnd.google-apps.folder',
          }
        }
        return { files: [] }
      })

      const folderId = await GoogleDriveClient.getOrCreateRootFolder(userId)

      expect(folderId).toBe(createdFolderId)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(2)

      const postCall = fetchUtils.fetchJson.mock.calls[1]
      expect(postCall[0]).toBe('https://www.googleapis.com/drive/v3/files')
      expect(postCall[1].method).toBe('POST')
      expect(postCall[1].headers.Authorization).toBe(
        `Bearer ${validAccessToken}`
      )
      expect(postCall[1].json).toEqual({
        name: 'Overleaf',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
      })

      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledWith(
        { user_id: expect.anything() },
        {
          $set: {
            rootFolderId: createdFolderId,
            updatedAt: expect.any(Date),
          },
        }
      )
    })

    it('handles custom root folder names and escapes quotes in query', async function () {
      const customName = "Bob's Work & Research"
      fetchUtils.fetchJson.mockResolvedValue({
        files: [{ id: 'custom-root-id', name: customName }],
      })

      const folderId = await GoogleDriveClient.getOrCreateRootFolder(
        userId,
        customName
      )

      expect(folderId).toBe('custom-root-id')
      const [url] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toContain(
        encodeURIComponent(
          "mimeType = 'application/vnd.google-apps.folder' and name = 'Bob\\'s Work & Research' and trashed = false and 'root' in parents"
        )
      )
    })
  })

  describe('getOrCreateProjectFolder & getOrCreateSubfolder', function () {
    it('returns existing project folder ID if found under rootFolderId', async function () {
      const projectName = 'Quantum Computing Thesis'
      fetchUtils.fetchJson.mockResolvedValue({
        files: [{ id: projectFolderId, name: projectName }],
      })

      const folderId = await GoogleDriveClient.getOrCreateProjectFolder(
        userId,
        rootFolderId,
        projectName
      )

      expect(folderId).toBe(projectFolderId)
      const [url, opts] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toContain('https://www.googleapis.com/drive/v3/files')
      expect(url).toContain(
        encodeURIComponent(
          `mimeType = 'application/vnd.google-apps.folder' and name = 'Quantum Computing Thesis' and '${rootFolderId}' in parents and trashed = false`
        )
      )
      expect(opts.headers.Authorization).toBe(`Bearer ${validAccessToken}`)
    })

    it('creates project folder under rootFolderId if not found', async function () {
      const projectName = 'Neural Networks Paper'
      const createdProjFolderId = 'created-proj-id-555'

      fetchUtils.fetchJson.mockImplementation(async (url, opts) => {
        if (opts.method === 'POST') {
          return {
            id: createdProjFolderId,
            name: projectName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [rootFolderId],
          }
        }
        return { files: [] }
      })

      const folderId = await GoogleDriveClient.getOrCreateProjectFolder(
        userId,
        rootFolderId,
        projectName
      )

      expect(folderId).toBe(createdProjFolderId)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(2)

      const postCall = fetchUtils.fetchJson.mock.calls[1]
      expect(postCall[0]).toBe('https://www.googleapis.com/drive/v3/files')
      expect(postCall[1].method).toBe('POST')
      expect(postCall[1].json).toEqual({
        name: projectName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [rootFolderId],
      })
    })

    it('correctly creates nested subfolders via getOrCreateSubfolder', async function () {
      const subfolderName = 'figures'
      const subfolderId = 'subfolder-id-777'

      fetchUtils.fetchJson.mockResolvedValue({
        files: [{ id: subfolderId, name: subfolderName }],
      })

      const resultId = await GoogleDriveClient.getOrCreateSubfolder(
        userId,
        projectFolderId,
        subfolderName
      )

      expect(resultId).toBe(subfolderId)
      const [url] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toContain(
        encodeURIComponent(
          `mimeType = 'application/vnd.google-apps.folder' and name = 'figures' and '${projectFolderId}' in parents and trashed = false`
        )
      )
    })
  })

  describe('uploadFile', function () {
    const fileName = 'main.tex'
    const content =
      '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}'
    const mimeType = 'text/x-tex'

    it('creates a new file using multipart upload when existingFileId is null', async function () {
      const responsePayload = {
        id: 'new-uploaded-file-id-888',
        name: fileName,
        md5Checksum: 'c157a79031e1c40f85931829bc5fc552',
        modifiedTime: '2026-08-30T12:00:00.000Z',
        size: '72',
        mimeType,
      }

      fetchUtils.fetchJson.mockResolvedValue(responsePayload)

      const result = await GoogleDriveClient.uploadFile(
        userId,
        projectFolderId,
        fileName,
        content,
        mimeType
      )

      expect(result).toEqual(responsePayload)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(1)

      const [url, opts] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toContain(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
      )
      expect(url).toContain(
        `fields=${encodeURIComponent('id,name,md5Checksum,modifiedTime,size,mimeType')}`
      )
      expect(opts.method).toBe('POST')
      expect(opts.headers.Authorization).toBe(`Bearer ${validAccessToken}`)
      expect(opts.headers['Content-Type']).toContain(
        'multipart/related; boundary='
      )
      expect(opts.headers['Content-Length']).toBeDefined()

      const bodyBuffer = opts.body
      expect(Buffer.isBuffer(bodyBuffer)).toBe(true)
      const bodyString = bodyBuffer.toString('utf8')
      expect(bodyString).toContain(`"name":"${fileName}"`)
      expect(bodyString).toContain(`"parents":["${projectFolderId}"]`)
      expect(bodyString).toContain(content)
    })

    it('updates an existing file using PATCH multipart upload when existingFileId is provided', async function () {
      const existingFileId = 'existing-file-id-999'
      const responsePayload = {
        id: existingFileId,
        name: fileName,
        md5Checksum: 'updated-md5-hash',
        modifiedTime: '2026-08-30T12:05:00.000Z',
        size: '120',
        mimeType,
      }

      fetchUtils.fetchJson.mockResolvedValue(responsePayload)

      const result = await GoogleDriveClient.uploadFile(
        userId,
        projectFolderId,
        fileName,
        Buffer.from(content, 'utf8'),
        mimeType,
        existingFileId
      )

      expect(result).toEqual(responsePayload)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(1)

      const [url, opts] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toContain(
        `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
      )
      expect(opts.method).toBe('PATCH')
      expect(opts.headers.Authorization).toBe(`Bearer ${validAccessToken}`)

      const bodyString = opts.body.toString('utf8')
      expect(bodyString).toContain(`"name":"${fileName}"`)
      expect(bodyString).toContain(content)
    })

    it('handles stream content inputs correctly', async function () {
      const stream = Readable.from([
        Buffer.from('chunk1-'),
        Buffer.from('chunk2-'),
        Buffer.from('chunk3'),
      ])

      const responsePayload = {
        id: 'streamed-file-id',
        name: 'data.csv',
        md5Checksum: 'csv-md5',
        modifiedTime: '2026-08-30T12:10:00.000Z',
        size: '21',
        mimeType: 'text/csv',
      }

      fetchUtils.fetchJson.mockResolvedValue(responsePayload)

      const result = await GoogleDriveClient.uploadFile(
        userId,
        projectFolderId,
        'data.csv',
        stream,
        'text/csv'
      )

      expect(result).toEqual(responsePayload)
      const bodyString =
        fetchUtils.fetchJson.mock.calls[0][1].body.toString('utf8')
      expect(bodyString).toContain('chunk1-chunk2-chunk3')
    })
  })

  describe('downloadFile', function () {
    const fileId = 'file-to-download-123'

    it('returns a readable stream from Google Drive media download endpoint', async function () {
      const mockStream = Readable.from(['file content downloaded'])
      fetchUtils.fetchStream.mockResolvedValue(mockStream)

      const stream = await GoogleDriveClient.downloadFile(userId, fileId)

      expect(stream).toBe(mockStream)
      expect(fetchUtils.fetchStream).toHaveBeenCalledTimes(1)

      const [url, opts] = fetchUtils.fetchStream.mock.calls[0]
      expect(url).toBe(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
      )
      expect(opts.headers.Authorization).toBe(`Bearer ${validAccessToken}`)
    })

    it('downloads file content as a Buffer using downloadFileBuffer', async function () {
      const mockStream = Readable.from([
        Buffer.from('part1-'),
        Buffer.from('part2'),
      ])
      fetchUtils.fetchStream.mockResolvedValue(mockStream)

      const buffer = await GoogleDriveClient.downloadFileBuffer(userId, fileId)

      expect(Buffer.isBuffer(buffer)).toBe(true)
      expect(buffer.toString('utf8')).toBe('part1-part2')
    })
  })

  describe('deleteFile', function () {
    const fileId = 'file-to-delete-456'

    it('calls DELETE on the Google Drive file endpoint', async function () {
      fetchUtils.fetchNothing.mockResolvedValue({})

      const result = await GoogleDriveClient.deleteFile(userId, fileId)

      expect(result).toEqual({ success: true })
      expect(fetchUtils.fetchNothing).toHaveBeenCalledTimes(1)

      const [url, opts] = fetchUtils.fetchNothing.mock.calls[0]
      expect(url).toBe(`https://www.googleapis.com/drive/v3/files/${fileId}`)
      expect(opts.method).toBe('DELETE')
      expect(opts.headers.Authorization).toBe(`Bearer ${validAccessToken}`)
    })
  })

  describe('getStartPageToken', function () {
    it('retrieves the startPageToken and updates credentials in DB', async function () {
      const startPageToken = '1234567890_start_token'
      fetchUtils.fetchJson.mockResolvedValue({
        kind: 'drive#startPageToken',
        startPageToken,
      })

      const token = await GoogleDriveClient.getStartPageToken(userId)

      expect(token).toBe(startPageToken)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(1)

      const [url, opts] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toBe(
        'https://www.googleapis.com/drive/v3/changes/startPageToken'
      )
      expect(opts.headers.Authorization).toBe(`Bearer ${validAccessToken}`)

      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledWith(
        { user_id: expect.anything() },
        {
          $set: {
            startPageToken,
            updatedAt: expect.any(Date),
          },
        }
      )
    })
  })

  describe('getChanges', function () {
    const pageToken = 'change-page-token-abc'

    it('fetches changes list with includeRemoved and required fields', async function () {
      const changesResponse = {
        changes: [
          {
            fileId: 'file-1',
            removed: false,
            file: {
              id: 'file-1',
              name: 'main.tex',
              mimeType: 'text/x-tex',
              parents: [projectFolderId],
              trashed: false,
              md5Checksum: 'hash1',
              modifiedTime: '2026-08-30T10:00:00.000Z',
            },
          },
          {
            fileId: 'file-2',
            removed: true,
          },
        ],
        nextPageToken: 'next-page-token-xyz',
        newStartPageToken: null,
      }

      fetchUtils.fetchJson.mockResolvedValue(changesResponse)

      const result = await GoogleDriveClient.getChanges(userId, pageToken)

      expect(result).toEqual({
        changes: changesResponse.changes,
        nextPageToken: 'next-page-token-xyz',
        newStartPageToken: null,
      })

      const [url, opts] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toContain('https://www.googleapis.com/drive/v3/changes')
      expect(url).toContain(`pageToken=${pageToken}`)
      expect(url).toContain('includeRemoved=true')
      expect(url).toContain(
        'fields=nextPageToken%2CnewStartPageToken%2Cchanges(fileId%2Cremoved%2Cfile(id%2Cname%2CmimeType%2Cparents%2Ctrashed%2Cmd5Checksum%2CmodifiedTime))'
      )
      expect(opts.headers.Authorization).toBe(`Bearer ${validAccessToken}`)
    })

    it('returns empty changes array when changes field is missing or empty', async function () {
      fetchUtils.fetchJson.mockResolvedValue({
        nextPageToken: null,
        newStartPageToken: 'new-start-token-999',
      })

      const result = await GoogleDriveClient.getChanges(userId, pageToken)

      expect(result).toEqual({
        changes: [],
        nextPageToken: null,
        newStartPageToken: 'new-start-token-999',
      })
    })
  })

  describe('getFileMetadata & listFiles', function () {
    it('retrieves file metadata with specified fields', async function () {
      const fileId = 'metadata-file-123'
      const metadata = {
        id: fileId,
        name: 'test.tex',
        mimeType: 'text/x-tex',
        parents: [projectFolderId],
        trashed: false,
        md5Checksum: 'md5',
        modifiedTime: '2026-08-30T10:00:00.000Z',
        size: '100',
      }
      fetchUtils.fetchJson.mockResolvedValue(metadata)

      const result = await GoogleDriveClient.getFileMetadata(userId, fileId)

      expect(result).toEqual(metadata)
      const [url] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toContain(
        `https://www.googleapis.com/drive/v3/files/${fileId}`
      )
      expect(url).toContain(
        'fields=id%2Cname%2CmimeType%2Cparents%2Ctrashed%2Cmd5Checksum%2CmodifiedTime%2Csize'
      )
    })

    it('lists files matching a custom query', async function () {
      const files = [
        { id: 'f1', name: 'f1.tex' },
        { id: 'f2', name: 'f2.tex' },
      ]
      fetchUtils.fetchJson.mockResolvedValue({ files, nextPageToken: 'p2' })

      const result = await GoogleDriveClient.listFiles(
        userId,
        `'${projectFolderId}' in parents and trashed = false`
      )

      expect(result.files).toEqual(files)
      expect(result.nextPageToken).toBe('p2')
      const [url] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toContain('https://www.googleapis.com/drive/v3/files')
    })
  })

  describe('Rate Limiting & Retry Handling', function () {
    it('retries on 429 rate limit error and succeeds on second attempt', async function () {
      const headersMap = new Map()
      headersMap.set('Retry-After', '0')
      const rateLimitError = new MockRequestFailedError(
        'Rate limit exceeded',
        { status: 429 },
        { status: 429, headers: headersMap }
      )

      fetchUtils.fetchJson
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          files: [{ id: rootFolderId, name: 'Overleaf' }],
        })

      const folderId = await GoogleDriveClient.getOrCreateRootFolder(
        userId,
        'Overleaf'
      )

      expect(folderId).toBe(rootFolderId)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(2)
      expect(logger.warn).toHaveBeenCalled()
    })

    it('retries on 503 service unavailable and succeeds', async function () {
      const serverError = new MockRequestFailedError(
        'Service Unavailable',
        { status: 503 },
        { status: 503, headers: new Map() }
      )

      fetchUtils.fetchJson
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce({
          files: [{ id: rootFolderId, name: 'Overleaf' }],
        })

      const folderId = await GoogleDriveClient.getOrCreateRootFolder(
        userId,
        'Overleaf'
      )

      expect(folderId).toBe(rootFolderId)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(2)
    })

    it('fails when max retries are exceeded on persistent 500 errors', async function () {
      const serverError = new MockRequestFailedError(
        'Internal Server Error',
        { status: 500 },
        { status: 500, headers: new Map() }
      )

      fetchUtils.fetchJson.mockRejectedValue(serverError)

      let error
      try {
        await GoogleDriveClient.getOrCreateRootFolder(userId, 'Overleaf')
      } catch (err) {
        error = err
      }
      expect(error).toBeDefined()
      expect(error.message).toMatch(/Internal Server Error/i)

      // Initial call + 5 retries = 6 calls total (maxRetries raised 3 -> 5 in Task 3)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(6)
    })

    it('does not retry on 400 Bad Request or 403 Forbidden', async function () {
      const clientError = new MockRequestFailedError(
        'Bad Request',
        { status: 400 },
        { status: 400, headers: new Map() }
      )

      fetchUtils.fetchJson.mockRejectedValue(clientError)

      let error
      try {
        await GoogleDriveClient.getOrCreateRootFolder(userId, 'Overleaf')
      } catch (err) {
        error = err
      }
      expect(error).toBeDefined()
      expect(error.message).toMatch(/Bad Request/i)

      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(1)
    })

    it('retries on network socket error (ECONNRESET) and succeeds', async function () {
      const socketError = new Error('read ECONNRESET')
      socketError.code = 'ECONNRESET'

      fetchUtils.fetchJson
        .mockRejectedValueOnce(socketError)
        .mockResolvedValueOnce({
          files: [{ id: rootFolderId, name: 'Overleaf' }],
        })

      const folderId = await GoogleDriveClient.getOrCreateRootFolder(
        userId,
        'Overleaf'
      )

      expect(folderId).toBe(rootFolderId)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(2)
    })

    it('handles lowercase retry-after in plain object headers', async function () {
      const rateLimitError = new MockRequestFailedError(
        'Rate limit exceeded',
        { status: 429 },
        { status: 429, headers: { 'retry-after': '0' } }
      )

      fetchUtils.fetchJson
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          files: [{ id: rootFolderId, name: 'Overleaf' }],
        })

      const folderId = await GoogleDriveClient.getOrCreateRootFolder(
        userId,
        'Overleaf'
      )

      expect(folderId).toBe(rootFolderId)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(2)
    })
  })

  describe('Additional Edge Cases & Helpers', function () {
    it('escapes complex project names containing single quotes, backslashes, and unicode', async function () {
      const complexProjectName = "Dr. O'Connor's \\Special\\ Project: 🚀 (2026)"
      fetchUtils.fetchJson.mockResolvedValue({
        files: [{ id: 'proj-complex-id', name: complexProjectName }],
      })

      const folderId = await GoogleDriveClient.getOrCreateProjectFolder(
        userId,
        rootFolderId,
        complexProjectName
      )

      expect(folderId).toBe('proj-complex-id')
      const [url] = fetchUtils.fetchJson.mock.calls[0]
      const expectedEscaped =
        "Dr. O\\'Connor\\'s \\\\Special\\\\ Project: 🚀 (2026)"
      expect(url).toContain(encodeURIComponent(expectedEscaped))
    })

    it('uploads empty file content when content is null or empty string', async function () {
      const responsePayload = {
        id: 'empty-file-id',
        name: 'empty.txt',
        md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e',
        modifiedTime: '2026-08-30T12:00:00.000Z',
        size: '0',
        mimeType: 'text/plain',
      }
      fetchUtils.fetchJson.mockResolvedValue(responsePayload)

      const result = await GoogleDriveClient.uploadFile(
        userId,
        projectFolderId,
        'empty.txt',
        '',
        'text/plain'
      )

      expect(result).toEqual(responsePayload)
      expect(fetchUtils.fetchJson).toHaveBeenCalledTimes(1)
    })

    it('supports userId passed as MockObjectId instance across client methods', async function () {
      const objId = new MockObjectId(userId)
      fetchUtils.fetchJson.mockResolvedValue({
        files: [{ id: rootFolderId, name: 'Overleaf' }],
      })

      const folderId = await GoogleDriveClient.getOrCreateRootFolder(objId)
      expect(folderId).toBe(rootFolderId)
      expect(GoogleDriveOAuthManager.getValidAccessToken).toHaveBeenCalledWith(
        objId
      )
    })

    it('passes pageToken correctly when listFiles is paginated', async function () {
      fetchUtils.fetchJson.mockResolvedValue({
        files: [{ id: 'f3', name: 'f3.tex' }],
        nextPageToken: null,
      })

      const result = await GoogleDriveClient.listFiles(
        userId,
        'trashed = false',
        'files(id,name)',
        'page-token-2'
      )

      expect(result.files.length).toBe(1)
      const [url] = fetchUtils.fetchJson.mock.calls[0]
      expect(url).toContain('pageToken=page-token-2')
    })
  })

  describe('rate limit handling', function () {
    function driveError(status, reason) {
      const err = new Error(`drive ${status}`)
      err.info = { status }
      err.body = reason
        ? { error: { errors: [{ reason }], status: reason } }
        : undefined
      return err
    }

    it('retries a 403 userRateLimitExceeded and eventually succeeds', async function () {
      let calls = 0
      fetchUtils.fetchJson.mockImplementation(async () => {
        calls++
        if (calls < 3) throw driveError(403, 'userRateLimitExceeded')
        return { files: [] }
      })

      const result = await GoogleDriveClient.listFiles('user-1', 'folder-1')

      expect(calls).toBe(3)
      expect(result).toBeDefined()
    })

    it('does not retry a 403 insufficientPermissions', async function () {
      let calls = 0
      fetchUtils.fetchJson.mockImplementation(async () => {
        calls++
        throw driveError(403, 'insufficientPermissions')
      })

      let caught
      try {
        await GoogleDriveClient.listFiles('user-1', 'folder-1')
      } catch (err) {
        caught = err
      }

      expect(caught).toBeDefined()
      expect(calls).toBe(1)
    })

    it('tags the error with rateLimited when retries are exhausted', async function () {
      fetchUtils.fetchJson.mockImplementation(async () => {
        throw driveError(429)
      })

      let caught
      try {
        await GoogleDriveClient.listFiles('user-1', 'folder-1')
      } catch (err) {
        caught = err
      }

      expect(caught).toBeDefined()
      expect(caught.rateLimited).toBe(true)
    })

    it('does not tag non-rate-limit failures as rateLimited', async function () {
      fetchUtils.fetchJson.mockImplementation(async () => {
        throw driveError(500)
      })

      let caught
      try {
        await GoogleDriveClient.listFiles('user-1', 'folder-1')
      } catch (err) {
        caught = err
      }

      expect(caught).toBeDefined()
      expect(caught.rateLimited).toBeUndefined()
    })
  })

  describe('watchChanges and stopChannel', () => {
    it('calls changes.watch with correct headers and payload', async () => {
      fetchUtils.fetchJson.mockResolvedValue({
        kind: 'api#channel',
        id: 'chan-123',
        resourceId: 'res-456',
        expiration: '1756800000000',
      })

      const channelData = {
        id: 'chan-123',
        type: 'web_hook',
        address: 'https://example.com/google-drive/webhook',
        token: 'signed-token',
      }

      const res = await GoogleDriveClient.watchChanges(
        userId,
        'page-token-1',
        channelData
      )

      expect(fetchUtils.fetchJson).toHaveBeenCalledWith(
        'https://www.googleapis.com/drive/v3/changes/watch?pageToken=page-token-1',
        expect.objectContaining({
          method: 'POST',
          json: channelData,
          headers: expect.objectContaining({
            Authorization: `Bearer ${validAccessToken}`,
          }),
        })
      )
      expect(res.id).toBe('chan-123')
      expect(res.resourceId).toBe('res-456')
    })

    it('calls channels.stop with channel id and resource id', async () => {
      fetchUtils.fetchNothing.mockResolvedValue()

      await GoogleDriveClient.stopChannel(userId, 'chan-123', 'res-456')

      expect(fetchUtils.fetchNothing).toHaveBeenCalledWith(
        'https://www.googleapis.com/drive/v3/channels/stop',
        expect.objectContaining({
          method: 'POST',
          json: {
            id: 'chan-123',
            resourceId: 'res-456',
          },
          headers: expect.objectContaining({
            Authorization: `Bearer ${validAccessToken}`,
          }),
        })
      )
    })
  })
})
