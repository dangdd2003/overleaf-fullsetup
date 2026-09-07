import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest'
import { Readable } from 'node:stream'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs'

describe('GoogleDriveSyncManager', function () {
  let GoogleDriveSyncManager

  const userId = '60d5ecb8b392d40015b6d5a1'
  const projectId = '60d5ecb8b392d40015b6d5b2'
  const docId = '60d5ecb8b392d40015b6d5c3'
  const fileId = '60d5ecb8b392d40015b6d5d4'
  const rootFolderId = 'gdrive-root-folder-id-111'
  const projectFolderId = 'gdrive-project-folder-id-222'
  const driveFileId = 'gdrive-file-id-333'

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

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const Settings = {
    googleDrive: { folderName: 'Overleaf' },
  }

  const db = {
    googleDriveUserCredentials: {
      findOne: vi.fn(),
      updateOne: vi.fn(),
    },
    googleDriveProjectStates: {
      findOne: vi.fn(),
      find: vi.fn(),
      findOneAndUpdate: vi.fn(),
      insertOne: vi.fn(),
      updateOne: vi.fn(),
    },
  }

  const GoogleDriveClient = {
    getOrCreateRootFolder: vi.fn(),
    getOrCreateSubfolder: vi.fn(),
    getOrCreateProjectFolder: vi.fn(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    downloadFileBuffer: vi.fn(),
    deleteFile: vi.fn(),
    getStartPageToken: vi.fn(),
    getChanges: vi.fn(),
    listFiles: vi.fn(),
    getFileMetadata: vi.fn(),
  }

  const GoogleDriveOAuthManager = {
    getValidAccessToken: vi.fn(),
    isLinked: vi.fn(),
  }

  const EditorController = {
    promises: {
      upsertDocWithPath: vi.fn(),
      upsertFileWithPath: vi.fn(),
      deleteEntityWithPath: vi.fn(),
      renameEntity: vi.fn(),
      moveEntity: vi.fn(),
      mkdirp: vi.fn(),
    },
  }

  const DocstoreManager = {
    promises: {
      getDoc: vi.fn(),
      getAllDocs: vi.fn(),
    },
  }

  const FileStoreController = {}

  const ProjectEntityHandler = {
    promises: {
      getAllEntities: vi.fn(),
      getAllDocs: vi.fn(),
      getAllFiles: vi.fn(),
    },
    getAllEntitiesFromProject: vi.fn(),
  }

  const ProjectGetter = {
    promises: {
      getProject: vi.fn(),
      findUsersProjectsByName: vi.fn(),
    },
  }

  const ProjectCreationHandler = {
    promises: {
      createBlankProject: vi.fn(),
    },
  }

  const ProjectDetailsHandler = {
    promises: {
      getDetails: vi.fn(),
    },
  }

  const HistoryManager = {
    promises: {
      requestBlobWithProjectId: vi.fn(),
    },
  }

  const DocumentUpdaterHandler = {
    promises: {
      flushProjectToMongo: vi.fn(),
    },
  }

  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('@overleaf/settings', () => ({ default: Settings }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
    ObjectId: MockObjectId,
  }))
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveClient.mjs',
    () => ({
      default: GoogleDriveClient,
      ...GoogleDriveClient,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveOAuthManager.mjs',
    () => ({
      default: GoogleDriveOAuthManager,
      ...GoogleDriveOAuthManager,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Editor/EditorController.mjs',
    () => ({
      default: EditorController,
      ...EditorController,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Docstore/DocstoreManager.mjs',
    () => ({
      default: DocstoreManager,
      ...DocstoreManager,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/FileStore/FileStoreController.mjs',
    () => ({
      default: FileStoreController,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectEntityHandler.mjs',
    () => ({
      default: ProjectEntityHandler,
      ...ProjectEntityHandler,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectGetter.mjs',
    () => ({
      default: ProjectGetter,
      ...ProjectGetter,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectCreationHandler.mjs',
    () => ({
      default: ProjectCreationHandler,
      ...ProjectCreationHandler,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Project/ProjectDetailsHandler.mjs',
    () => ({
      default: ProjectDetailsHandler,
      ...ProjectDetailsHandler,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/History/HistoryManager.mjs',
    () => ({
      default: HistoryManager,
      ...HistoryManager,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
    () => ({
      default: DocumentUpdaterHandler,
      ...DocumentUpdaterHandler,
    })
  )

  beforeEach(async () => {
    vi.clearAllMocks()
    Settings.googleDrive = { folderName: 'Overleaf' }
    DocumentUpdaterHandler.promises.flushProjectToMongo.mockResolvedValue(
      undefined
    )
    GoogleDriveSyncManager = (await import(modulePath)).default
  })

  describe('isIgnoredFile', function () {
    it('ignores LaTeX auxiliary and log artifacts', function () {
      const ignoredFiles = [
        'main.aux',
        'document.log',
        'report.toc',
        'paper.out',
        'thesis.synctex.gz',
        'build.fls',
        'file.fdb_latexmk',
        'ref.bbl',
        'ref.blg',
        'beamer.nav',
        'beamer.snm',
        'beamer.vrb',
        'output.dvi',
        'output.ps',
        'figures.lof',
        'tables.lot',
      ]

      for (const f of ignoredFiles) {
        expect(GoogleDriveSyncManager.isIgnoredFile(f)).toBe(true)
        expect(GoogleDriveSyncManager.isIgnoredFile(`subfolder/${f}`)).toBe(
          true
        )
        expect(GoogleDriveSyncManager.isIgnoredFile(f.toUpperCase())).toBe(true)
      }
    })

    it('ignores OS noise files and git metadata', function () {
      const noiseFiles = [
        '.DS_Store',
        'sub/.DS_Store',
        'Thumbs.db',
        'desktop.ini',
        '.git/config',
        '.git/HEAD',
      ]

      for (const f of noiseFiles) {
        expect(GoogleDriveSyncManager.isIgnoredFile(f)).toBe(true)
      }
    })

    it('does NOT ignore valid source code and asset files', function () {
      const validFiles = [
        'main.tex',
        'references.bib',
        'styles.sty',
        'thesis.cls',
        'figures/diagram.png',
        'figures/photo.jpg',
        'figures/vector.pdf',
        'data/results.csv',
        'README.md',
        'notes.txt',
      ]

      for (const f of validFiles) {
        expect(GoogleDriveSyncManager.isIgnoredFile(f)).toBe(false)
      }
    })

    it('returns true for empty or non-string inputs', function () {
      expect(GoogleDriveSyncManager.isIgnoredFile(null)).toBe(true)
      expect(GoogleDriveSyncManager.isIgnoredFile('')).toBe(true)
      expect(GoogleDriveSyncManager.isIgnoredFile(undefined)).toBe(true)
    })
  })

  describe('isBinaryFile', function () {
    it('identifies binary files by extension', function () {
      expect(GoogleDriveSyncManager.isBinaryFile('image.png')).toBe(true)
      expect(GoogleDriveSyncManager.isBinaryFile('doc.pdf')).toBe(true)
      expect(GoogleDriveSyncManager.isBinaryFile('figure.eps')).toBe(true)
      expect(GoogleDriveSyncManager.isBinaryFile('archive.zip')).toBe(true)
      expect(GoogleDriveSyncManager.isBinaryFile('font.woff2')).toBe(true)
    })

    it('identifies text / doc files as non-binary', function () {
      expect(GoogleDriveSyncManager.isBinaryFile('main.tex')).toBe(false)
      expect(GoogleDriveSyncManager.isBinaryFile('ref.bib')).toBe(false)
      expect(GoogleDriveSyncManager.isBinaryFile('notes.txt')).toBe(false)
      expect(GoogleDriveSyncManager.isBinaryFile('README.md')).toBe(false)
    })

    it('uses mimeType to distinguish text vs binary', function () {
      expect(
        GoogleDriveSyncManager.isBinaryFile('unknown_file', 'image/jpeg')
      ).toBe(true)
      expect(
        GoogleDriveSyncManager.isBinaryFile('unknown_file', 'text/plain')
      ).toBe(false)
      expect(
        GoogleDriveSyncManager.isBinaryFile(
          'main.tex',
          'application/octet-stream'
        )
      ).toBe(false)
    })
  })

  describe('normalizePath', function () {
    it('strips leading slashes and normalizes separators', function () {
      expect(GoogleDriveSyncManager.normalizePath('/main.tex')).toBe('main.tex')
      expect(GoogleDriveSyncManager.normalizePath('///a/b/c.tex')).toBe(
        'a/b/c.tex'
      )
      expect(GoogleDriveSyncManager.normalizePath('a\\b\\c.tex')).toBe(
        'a/b/c.tex'
      )
      expect(GoogleDriveSyncManager.normalizePath('')).toBe('')
      expect(GoogleDriveSyncManager.normalizePath(null)).toBe('')
    })
  })

  describe('encodePathKey / decodePathKey', () => {
    it('escapes dots and dollars, which Mongo forbids in field names', () => {
      const key = GoogleDriveSyncManager.encodePathKey('figures/plot.v2.png')
      expect(key).not.toContain('.')
      expect(key).not.toContain('$')
    })

    it('round-trips every path shape we expect', () => {
      const paths = [
        'main.tex',
        'figures/plot.png',
        'a/b/c/deep.file.name.tex',
        'weird$name.tex',
        'spaces in name.bib',
        'unicode-éà.tex',
      ]
      for (const p of paths) {
        const key = GoogleDriveSyncManager.encodePathKey(p)
        expect(GoogleDriveSyncManager.decodePathKey(key)).toBe(p)
      }
    })

    it('produces distinct keys for distinct paths', () => {
      const a = GoogleDriveSyncManager.encodePathKey('a.b')
      const b = GoogleDriveSyncManager.encodePathKey('a/b')
      expect(a).not.toBe(b)
    })
  })

  describe('recordSyncFailure', () => {
    it('sets an exponential backoff window and increments the failure count', async () => {
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId,
        consecutiveFailures: 2,
      })

      const err = new Error('quota')
      err.rateLimited = true
      await GoogleDriveSyncManager.recordSyncFailure(projectId, err)

      const update = db.googleDriveProjectStates.updateOne.mock.calls[0][1]
      expect(update.$set.consecutiveFailures).toBe(3)
      expect(update.$set.syncStatus).toBe('error')
      expect(update.$set.lastOutboundError).toContain('quota')
      // base 5 min, doubled twice for the 2 prior failures => 20 min
      const backoffMs = update.$set.backoffUntil.getTime() - Date.now()
      expect(backoffMs).toBeGreaterThan(19 * 60 * 1000)
      expect(backoffMs).toBeLessThan(21 * 60 * 1000)
    })

    it('caps the backoff at one hour', async () => {
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId,
        consecutiveFailures: 20,
      })

      await GoogleDriveSyncManager.recordSyncFailure(projectId, new Error('x'))

      const update = db.googleDriveProjectStates.updateOne.mock.calls[0][1]
      const backoffMs = update.$set.backoffUntil.getTime() - Date.now()
      expect(backoffMs).toBeLessThanOrEqual(60 * 60 * 1000 + 1000)
    })
  })

  describe('clearSyncFailure', () => {
    it('resets the failure count and removes the backoff', async () => {
      await GoogleDriveSyncManager.clearSyncFailure(projectId)

      const update = db.googleDriveProjectStates.updateOne.mock.calls[0][1]
      expect(update.$set.consecutiveFailures).toBe(0)
      expect(update.$unset).toHaveProperty('backoffUntil')
    })
  })

  describe('enforceManualSyncCooldown', () => {
    it('defaults the cooldown from settings', async () => {
      Settings.googleDrive.manualSyncCooldownSeconds = 30
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        projectId,
      })

      await GoogleDriveSyncManager.enforceManualSyncCooldown(projectId)

      const query =
        db.googleDriveProjectStates.findOneAndUpdate.mock.calls[0][0]
      const cutoff = query.$or[2].lastManualSyncAt.$lt
      const windowMs = Date.now() - cutoff.getTime()
      expect(windowMs).toBeGreaterThan(29000)
      expect(windowMs).toBeLessThan(31000)
    })
  })

  describe('generateConflictPath', function () {
    it('generates conflict file path with timestamp', function () {
      const fixedDate = new Date('2026-08-30T17:35:00Z')
      const conflict = GoogleDriveSyncManager.generateConflictPath(
        'main.tex',
        fixedDate
      )
      expect(conflict).toBe('main (Google Drive Conflict 2026-08-30-1735).tex')
    })

    it('preserves folder path in conflict filename', function () {
      const fixedDate = new Date('2026-08-30T17:35:00Z')
      const conflict = GoogleDriveSyncManager.generateConflictPath(
        'chapters/intro.tex',
        fixedDate
      )
      expect(conflict).toBe(
        'chapters/intro (Google Drive Conflict 2026-08-30-1735).tex'
      )
    })

    it('handles files with no extension', function () {
      const fixedDate = new Date('2026-08-30T17:35:00Z')
      const conflict = GoogleDriveSyncManager.generateConflictPath(
        'Makefile',
        fixedDate
      )
      expect(conflict).toBe('Makefile (Google Drive Conflict 2026-08-30-1735)')
    })
  })

  describe('Project Lock Management', function () {
    it('acquires lock when not locked', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: {
          projectId: new MockObjectId(projectId),
          isSyncing: true,
        },
      })

      const acquired =
        await GoogleDriveSyncManager.acquireProjectLock(projectId)
      expect(acquired).toBe(true)
      expect(db.googleDriveProjectStates.findOneAndUpdate).toHaveBeenCalled()
    })

    it('acquires lock when state document does not exist yet', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue(null)
      db.googleDriveProjectStates.findOne.mockResolvedValue(null)
      db.googleDriveProjectStates.insertOne.mockResolvedValue({
        insertedId: projectId,
      })

      const acquired =
        await GoogleDriveSyncManager.acquireProjectLock(projectId)
      expect(acquired).toBe(true)
      expect(db.googleDriveProjectStates.insertOne).toHaveBeenCalled()
    })

    it('fails to acquire lock when already locked', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue(null)
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        isSyncing: true,
        lockExpiresAt: new Date(Date.now() + 50000),
      })

      const acquired =
        await GoogleDriveSyncManager.acquireProjectLock(projectId)
      expect(acquired).toBe(false)
    })

    it('releases lock cleanly', async function () {
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      const released =
        await GoogleDriveSyncManager.releaseProjectLock(projectId)
      expect(released).toBe(true)
      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        { projectId: expect.anything() },
        { $set: { isSyncing: false, lockExpiresAt: null } }
      )
    })

    it('handles database error when releasing lock', async function () {
      db.googleDriveProjectStates.updateOne.mockRejectedValue(
        new Error('DB Error')
      )

      const released =
        await GoogleDriveSyncManager.releaseProjectLock(projectId)
      expect(released).toBe(false)
      expect(logger.warn).toHaveBeenCalled()
    })
  })

  describe('Manual Sync Cooldown', function () {
    beforeEach(function () {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    })

    afterEach(function () {
      vi.useRealTimers()
    })

    it('allows the first manual sync when no state document exists yet', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue(null)
      db.googleDriveProjectStates.findOne.mockResolvedValue(null)

      const cooldown =
        await GoogleDriveSyncManager.enforceManualSyncCooldown(projectId)

      expect(cooldown).toEqual({ allowed: true })
    })

    it('allows a manual sync when the last one was more than 60s ago', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: {
          projectId: new MockObjectId(projectId),
          lastManualSyncAt: new Date('2026-09-02T11:58:00.000Z'),
        },
      })

      const cooldown =
        await GoogleDriveSyncManager.enforceManualSyncCooldown(projectId)

      expect(cooldown).toEqual({ allowed: true })
      expect(db.googleDriveProjectStates.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: expect.anything() }),
        { $set: { lastManualSyncAt: new Date('2026-09-02T12:00:00.000Z') } },
        expect.anything()
      )
    })

    it('blocks a manual sync within 60s and reports the seconds remaining', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue(null)
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        lastManualSyncAt: new Date('2026-09-02T11:59:31.000Z'), // 29s ago
      })

      const cooldown =
        await GoogleDriveSyncManager.enforceManualSyncCooldown(projectId)

      expect(cooldown).toEqual({ allowed: false, retryAfterSeconds: 31 })
    })
  })

  describe('getProjectStatus', function () {
    it('returns unlinked status when the account is not linked to Google Drive', async function () {
      GoogleDriveOAuthManager.isLinked.mockResolvedValue({ isLinked: false })
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        driveFolderId: projectFolderId,
      })

      const status = await GoogleDriveSyncManager.getProjectStatus(
        projectId,
        userId
      )
      expect(status).toEqual({
        linked: false,
        syncStatus: 'unlinked',
        isSyncing: false,
        fileCount: 0,
      })
    })

    it('returns linked, never-synced status when the account is linked but the project has no sync state yet', async function () {
      GoogleDriveOAuthManager.isLinked.mockResolvedValue({ isLinked: true })
      db.googleDriveProjectStates.findOne.mockResolvedValue(null)

      const status = await GoogleDriveSyncManager.getProjectStatus(
        projectId,
        userId
      )
      expect(status).toEqual({
        linked: true,
        syncStatus: 'idle',
        isSyncing: false,
        fileCount: 0,
      })
    })

    it('returns linked status with details when the account is linked and project state exists', async function () {
      GoogleDriveOAuthManager.isLinked.mockResolvedValue({ isLinked: true })
      const lastSynced = new Date()
      const lastManualSynced = new Date()
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        driveFolderId: projectFolderId,
        folderName: 'My Project',
        syncStatus: 'idle',
        lastSyncedAt: lastSynced,
        lastManualSyncAt: lastManualSynced,
        lastError: null,
        isSyncing: false,
        fileMap: { 'main.tex': {}, 'ref.bib': {} },
      })

      const status = await GoogleDriveSyncManager.getProjectStatus(
        projectId,
        userId
      )
      expect(status).toEqual({
        linked: true,
        driveFolderId: projectFolderId,
        folderName: 'My Project',
        syncStatus: 'idle',
        lastSyncedAt: lastSynced,
        lastManualSyncAt: lastManualSynced,
        lastError: null,
        isSyncing: false,
        fileCount: 2,
      })
    })

    it('returns null lastManualSyncAt when the project has never been manually synced', async function () {
      GoogleDriveOAuthManager.isLinked.mockResolvedValue({ isLinked: true })
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        driveFolderId: projectFolderId,
        folderName: 'My Project',
        syncStatus: 'idle',
        lastSyncedAt: new Date(),
        lastError: null,
        isSyncing: false,
        fileMap: {},
      })

      const status = await GoogleDriveSyncManager.getProjectStatus(
        projectId,
        userId
      )
      expect(status.lastManualSyncAt).toBeNull()
    })
  })

  describe('Outbound Synchronization', function () {
    describe('handleOutboundDocUpdate', function () {
      it('skips ignored files', async function () {
        const result = await GoogleDriveSyncManager.handleOutboundDocUpdate(
          projectId,
          docId,
          'main.aux',
          1
        )
        expect(result).toEqual({ ignored: true })
        expect(DocstoreManager.promises.getDoc).not.toHaveBeenCalled()
      })

      it('returns unlinked if project state has no driveFolderId', async function () {
        db.googleDriveProjectStates.findOne.mockResolvedValue(null)

        const result = await GoogleDriveSyncManager.handleOutboundDocUpdate(
          projectId,
          docId,
          'main.tex',
          1
        )
        expect(result).toEqual({ unlinked: true })
      })

      it('fetches doc content from Docstore and uploads to Google Drive', async function () {
        db.googleDriveProjectStates.findOne.mockResolvedValue({
          projectId: new MockObjectId(projectId),
          userId: new MockObjectId(userId),
          driveFolderId: projectFolderId,
          fileMap: {},
        })

        DocstoreManager.promises.getDoc.mockResolvedValue({
          lines: [
            '\\documentclass{article}',
            '\\begin{document}',
            'Hello',
            '\\end{document}',
          ],
          rev: 3,
        })

        GoogleDriveClient.uploadFile.mockResolvedValue({
          id: driveFileId,
          md5Checksum: 'checksum123',
          modifiedTime: '2026-08-30T17:00:00.000Z',
        })

        db.googleDriveProjectStates.updateOne.mockResolvedValue({
          modifiedCount: 1,
        })

        const result = await GoogleDriveSyncManager.handleOutboundDocUpdate(
          projectId,
          docId,
          'main.tex',
          3
        )

        expect(result).toEqual({
          success: true,
          driveFileId,
          fileMapEntry: expect.any(Object),
        })
        expect(DocstoreManager.promises.getDoc).toHaveBeenCalledWith(
          projectId,
          docId
        )
        expect(GoogleDriveClient.uploadFile).toHaveBeenCalledWith(
          expect.anything(),
          projectFolderId,
          'main.tex',
          expect.any(Buffer),
          'text/plain',
          null
        )
        expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalled()
      })

      it('creates subfolders in Google Drive if doc is nested', async function () {
        db.googleDriveProjectStates.findOne.mockResolvedValue({
          projectId: new MockObjectId(projectId),
          userId: new MockObjectId(userId),
          driveFolderId: projectFolderId,
          fileMap: {},
        })

        GoogleDriveClient.getOrCreateSubfolder.mockResolvedValue(
          'subfolder-drive-id-444'
        )
        DocstoreManager.promises.getDoc.mockResolvedValue({
          lines: ['Sub doc content'],
          rev: 1,
        })
        GoogleDriveClient.uploadFile.mockResolvedValue({
          id: driveFileId,
          md5Checksum: 'checksum456',
        })

        const result = await GoogleDriveSyncManager.handleOutboundDocUpdate(
          projectId,
          docId,
          'chapters/intro.tex',
          1
        )

        expect(result).toEqual({
          success: true,
          driveFileId,
          fileMapEntry: expect.any(Object),
        })
        expect(GoogleDriveClient.getOrCreateSubfolder).toHaveBeenCalledWith(
          expect.anything(),
          projectFolderId,
          'chapters'
        )
        expect(GoogleDriveClient.uploadFile).toHaveBeenCalledWith(
          expect.anything(),
          'subfolder-drive-id-444',
          'intro.tex',
          expect.any(Buffer),
          'text/plain',
          null
        )
      })

      it('updates existing Google Drive file if already in fileMap', async function () {
        db.googleDriveProjectStates.findOne.mockResolvedValue({
          projectId: new MockObjectId(projectId),
          userId: new MockObjectId(userId),
          driveFolderId: projectFolderId,
          fileMap: {
            'main.tex': {
              driveFileId: 'existing-drive-file-id-555',
              rev: 2,
            },
          },
        })

        DocstoreManager.promises.getDoc.mockResolvedValue({
          lines: ['Updated line'],
          rev: 3,
        })
        GoogleDriveClient.uploadFile.mockResolvedValue({
          id: 'existing-drive-file-id-555',
          md5Checksum: 'newchecksum',
        })

        const result = await GoogleDriveSyncManager.handleOutboundDocUpdate(
          projectId,
          docId,
          'main.tex',
          3
        )

        expect(result).toEqual({
          success: true,
          driveFileId: 'existing-drive-file-id-555',
          fileMapEntry: expect.any(Object),
        })
        expect(GoogleDriveClient.uploadFile).toHaveBeenCalledWith(
          expect.anything(),
          projectFolderId,
          'main.tex',
          expect.any(Buffer),
          'text/plain',
          'existing-drive-file-id-555'
        )
      })
    })

    describe('handleOutboundFileUpdate', function () {
      it('streams binary file from HistoryManager and uploads to Drive', async function () {
        db.googleDriveProjectStates.findOne.mockResolvedValue({
          projectId: new MockObjectId(projectId),
          userId: new MockObjectId(userId),
          driveFolderId: projectFolderId,
          fileMap: {},
        })

        const mockStream = Readable.from(['image data buffer'])
        HistoryManager.promises.requestBlobWithProjectId.mockResolvedValue({
          stream: mockStream,
          contentLength: 17,
        })

        GoogleDriveClient.uploadFile.mockResolvedValue({
          id: driveFileId,
          md5Checksum: 'imgmd5',
        })

        const result = await GoogleDriveSyncManager.handleOutboundFileUpdate(
          projectId,
          fileId,
          'plot.png',
          'hash123456'
        )

        expect(result).toEqual({
          success: true,
          driveFileId,
          fileMapEntry: expect.any(Object),
        })
        expect(
          HistoryManager.promises.requestBlobWithProjectId
        ).toHaveBeenCalledWith(projectId, 'hash123456', 'GET')
        expect(GoogleDriveClient.uploadFile).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'plot.png',
          mockStream,
          'image/png',
          null
        )
      })

      it('resolves hash from project entities if hash parameter is omitted', async function () {
        db.googleDriveProjectStates.findOne.mockResolvedValue({
          projectId: new MockObjectId(projectId),
          userId: new MockObjectId(userId),
          driveFolderId: projectFolderId,
          fileMap: {},
        })

        ProjectGetter.promises.getProject.mockResolvedValue({
          _id: new MockObjectId(projectId),
        })

        ProjectEntityHandler.getAllEntitiesFromProject.mockReturnValue({
          files: [
            {
              path: '/figures/plot.png',
              file: {
                _id: new MockObjectId(fileId),
                hash: 'resolved-hash-abc',
              },
            },
          ],
        })

        const mockStream = Readable.from(['image content'])
        HistoryManager.promises.requestBlobWithProjectId.mockResolvedValue({
          stream: mockStream,
          contentLength: 13,
        })

        GoogleDriveClient.uploadFile.mockResolvedValue({
          id: driveFileId,
          md5Checksum: 'imgmd5',
        })

        const result = await GoogleDriveSyncManager.handleOutboundFileUpdate(
          projectId,
          fileId,
          'figures/plot.png'
        )

        expect(result).toEqual({
          success: true,
          driveFileId,
          fileMapEntry: expect.any(Object),
        })
        expect(
          HistoryManager.promises.requestBlobWithProjectId
        ).toHaveBeenCalledWith(projectId, 'resolved-hash-abc', 'GET')
      })

      it('throws error if file hash cannot be resolved', async function () {
        db.googleDriveProjectStates.findOne.mockResolvedValue({
          projectId: new MockObjectId(projectId),
          userId: new MockObjectId(userId),
          driveFolderId: projectFolderId,
          fileMap: {},
        })

        ProjectGetter.promises.getProject.mockResolvedValue({
          _id: new MockObjectId(projectId),
        })

        ProjectEntityHandler.getAllEntitiesFromProject.mockReturnValue({
          files: [],
        })

        let error
        try {
          await GoogleDriveSyncManager.handleOutboundFileUpdate(
            projectId,
            fileId,
            'missing.png'
          )
        } catch (err) {
          error = err
        }
        expect(error).toBeDefined()
        expect(error.message).toMatch(/Cannot find file hash/i)
      })
    })

    describe('handleOutboundDelete', function () {
      it('deletes file in Google Drive and updates fileMap', async function () {
        db.googleDriveProjectStates.findOne.mockResolvedValue({
          projectId: new MockObjectId(projectId),
          userId: new MockObjectId(userId),
          driveFolderId: projectFolderId,
          fileMap: {
            'old.tex': {
              driveFileId: 'old-drive-id-999',
            },
          },
        })

        GoogleDriveClient.deleteFile.mockResolvedValue({ success: true })
        db.googleDriveProjectStates.updateOne.mockResolvedValue({
          modifiedCount: 1,
        })

        const result = await GoogleDriveSyncManager.handleOutboundDelete(
          projectId,
          'old.tex'
        )

        expect(result).toEqual({ success: true })
        expect(GoogleDriveClient.deleteFile).toHaveBeenCalledWith(
          expect.anything(),
          'old-drive-id-999'
        )
        expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
          { projectId: expect.anything() },
          {
            $set: {
              fileMap: {},
              lastSyncedAt: expect.any(Date),
            },
          }
        )
      })

      it('gracefully handles Google Drive delete error and removes from fileMap', async function () {
        db.googleDriveProjectStates.findOne.mockResolvedValue({
          projectId: new MockObjectId(projectId),
          userId: new MockObjectId(userId),
          driveFolderId: projectFolderId,
          fileMap: {
            'old.tex': {
              driveFileId: 'old-drive-id-999',
            },
          },
        })

        GoogleDriveClient.deleteFile.mockRejectedValue(
          new Error('File not found')
        )
        db.googleDriveProjectStates.updateOne.mockResolvedValue({
          modifiedCount: 1,
        })

        const result = await GoogleDriveSyncManager.handleOutboundDelete(
          projectId,
          'old.tex'
        )

        expect(result).toEqual({ success: true })
        expect(logger.warn).toHaveBeenCalled()
        expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalled()
      })
    })
  })

  describe('Inbound Synchronization: syncProject', function () {
    it('throws error when project lock cannot be acquired', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue(null)
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        isSyncing: true,
        lockExpiresAt: new Date(Date.now() + 50000),
      })

      let error
      try {
        await GoogleDriveSyncManager.syncProject(projectId, userId)
      } catch (err) {
        error = err
      }
      expect(error).toBeDefined()
      expect(error.message).toMatch(/Could not acquire project lock/i)
    })

    it('flushes pending document-updater edits to Mongo before reading docs', async function () {
      // Live editor keystrokes sit in document-updater's Redis and only reach
      // docstore when it flushes. Without an explicit flush, a manual "Sync
      // now" reconciles against stale docstore content and pushes nothing,
      // leaving the user to wait for the outbound worker's next tick.
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'My Project',
        owner_ref: new MockObjectId(userId),
      })

      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        projectFolderId
      )

      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        userId: new MockObjectId(userId),
        driveFolderId: projectFolderId,
        fileMap: {},
      })

      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [],
        folders: [],
      })
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])
      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [],
        nextPageToken: null,
      })

      await GoogleDriveSyncManager.syncProject(projectId, userId)

      expect(
        DocumentUpdaterHandler.promises.flushProjectToMongo
      ).toHaveBeenCalledWith(projectId)

      // The flush is only useful if it happens before the docs are read.
      const flushOrder =
        DocumentUpdaterHandler.promises.flushProjectToMongo.mock
          .invocationCallOrder[0]
      const readOrder =
        DocstoreManager.promises.getAllDocs.mock.invocationCallOrder[0]
      expect(flushOrder).toBeLessThan(readOrder)
    })

    it('performs full reconciliation between Overleaf and Google Drive', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'My Project',
        owner_ref: new MockObjectId(userId),
      })

      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        projectFolderId
      )

      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        userId: new MockObjectId(userId),
        driveFolderId: projectFolderId,
        fileMap: {
          'main.tex': {
            driveFileId: 'drive-main-1',
            rev: 1,
            md5Checksum: 'chk1',
          },
        },
      })

      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [
          {
            path: '/main.tex',
            doc: { _id: new MockObjectId(docId), name: 'main.tex' },
          },
        ],
        files: [],
        folders: [],
      })

      DocstoreManager.promises.getAllDocs.mockResolvedValue([
        {
          _id: docId,
          lines: ['\\documentclass{article}', 'Initial line'],
          rev: 1,
        },
      ])

      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [
          {
            id: 'drive-main-1',
            name: 'main.tex',
            mimeType: 'text/plain',
            md5Checksum: 'chk2',
            modifiedTime: '2026-08-30T17:20:00Z',
          },
        ],
        nextPageToken: null,
      })

      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('\\documentclass{article}\nDrive updated line', 'utf8')
      )

      EditorController.promises.upsertDocWithPath.mockResolvedValue({
        doc: { _id: docId, rev: 5 },
      })

      const res = await GoogleDriveSyncManager.syncProject(projectId, userId)

      expect(res.success).toBe(true)
      expect(EditorController.promises.upsertDocWithPath).toHaveBeenCalledWith(
        projectId,
        '/main.tex',
        ['\\documentclass{article}', 'Drive updated line'],
        'google-drive',
        userId
      )
      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        { projectId: expect.anything() },
        expect.objectContaining({
          $set: expect.objectContaining({
            fileMap: expect.objectContaining({
              'main.tex': expect.objectContaining({
                rev: 5,
              }),
            }),
          }),
        })
      )
    })

    it('generates a conflict copy when doc is modified in both places concurrently', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'My Project',
        owner_ref: new MockObjectId(userId),
      })

      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        projectFolderId
      )

      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        userId: new MockObjectId(userId),
        driveFolderId: projectFolderId,
        fileMap: {
          'main.tex': {
            driveFileId: 'drive-main-1',
            rev: 1,
            md5Checksum: 'chk1',
          },
        },
      })

      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [
          {
            path: '/main.tex',
            doc: { _id: new MockObjectId(docId), name: 'main.tex' },
          },
        ],
        files: [],
      })

      DocstoreManager.promises.getAllDocs.mockResolvedValue([
        {
          _id: docId,
          lines: ['\\documentclass{article}', 'Overleaf local edits'],
          rev: 3,
        },
      ])

      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [
          {
            id: 'drive-main-1',
            name: 'main.tex',
            mimeType: 'text/plain',
            md5Checksum: 'chk_drive_new',
          },
        ],
        nextPageToken: null,
      })

      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('\\documentclass{article}\nDrive conflicting edits', 'utf8')
      )

      EditorController.promises.upsertDocWithPath.mockResolvedValue({
        doc: { _id: 'conflict-doc-id' },
      })

      const res = await GoogleDriveSyncManager.syncProject(projectId, userId)

      expect(res.success).toBe(true)
      expect(
        EditorController.promises.upsertDocWithPath
      ).not.toHaveBeenCalledWith(
        projectId,
        '/main.tex',
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
      expect(EditorController.promises.upsertDocWithPath).toHaveBeenCalledWith(
        projectId,
        expect.stringMatching(/^\/main \(Google Drive Conflict .*\)\.tex$/),
        ['\\documentclass{article}', 'Drive conflicting edits'],
        'google-drive',
        userId
      )
      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        { projectId: expect.anything() },
        expect.objectContaining({
          $push: {
            conflicts: {
              $each: [
                expect.objectContaining({
                  path: 'main.tex',
                  conflictPath: expect.stringMatching(
                    /^main \(Google Drive Conflict .*\)\.tex$/
                  ),
                  detectedAt: expect.any(Date),
                }),
              ],
              $slice: -20,
            },
          },
        })
      )
    })

    it('generates a conflict copy when binary file is modified in both places concurrently', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'My Project',
        owner_ref: new MockObjectId(userId),
      })

      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        projectFolderId
      )

      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        userId: new MockObjectId(userId),
        driveFolderId: projectFolderId,
        fileMap: {
          'logo.png': {
            driveFileId: 'drive-file-png',
            md5Checksum: 'pngmd5-old',
            overleafHash: 'ov-hash-old',
            entityType: 'file',
          },
        },
      })

      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [
          {
            path: '/logo.png',
            file: { _id: fileId, name: 'logo.png', hash: 'ov-hash-new' },
          },
        ],
      })
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])

      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [
          {
            id: 'drive-file-png',
            name: 'logo.png',
            mimeType: 'image/png',
            md5Checksum: 'pngmd5-remote-new',
          },
        ],
        nextPageToken: null,
      })

      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('PNGDATA_REMOTE')
      )
      EditorController.promises.upsertFileWithPath.mockResolvedValue({
        file: {},
      })

      const res = await GoogleDriveSyncManager.syncProject(projectId, userId)

      expect(res.success).toBe(true)
      expect(
        EditorController.promises.upsertFileWithPath
      ).not.toHaveBeenCalledWith(
        projectId,
        '/logo.png',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
      expect(EditorController.promises.upsertFileWithPath).toHaveBeenCalledWith(
        projectId,
        expect.stringMatching(/^\/logo \(Google Drive Conflict .*\)\.png$/),
        expect.any(String),
        null,
        'google-drive',
        userId
      )
      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        { projectId: expect.anything() },
        expect.objectContaining({
          $push: {
            conflicts: {
              $each: [
                expect.objectContaining({
                  path: 'logo.png',
                  conflictPath: expect.stringMatching(
                    /^logo \(Google Drive Conflict .*\)\.png$/
                  ),
                  detectedAt: expect.any(Date),
                }),
              ],
              $slice: -20,
            },
          },
        })
      )
    })

    it('pushes the doc to Google Drive instead of creating a conflict copy, when only Overleaf changed since the last sync', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'My Project',
        owner_ref: new MockObjectId(userId),
      })

      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        projectFolderId
      )

      // Same state doc is read both by syncProject itself and internally by
      // handleOutboundDocUpdate - same shape works for both call sites here.
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        userId: new MockObjectId(userId),
        driveFolderId: projectFolderId,
        fileMap: {
          'main.tex': {
            driveFileId: 'drive-main-1',
            rev: 1,
            md5Checksum: 'chk1',
          },
        },
      })

      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [
          {
            path: '/main.tex',
            doc: { _id: new MockObjectId(docId), name: 'main.tex' },
          },
        ],
        files: [],
      })

      // Overleaf's rev moved (2 vs the last-synced 1) - only Overleaf changed.
      DocstoreManager.promises.getAllDocs.mockResolvedValue([
        {
          _id: docId,
          lines: ['\\documentclass{article}', 'Overleaf local edit'],
          rev: 2,
        },
      ])
      DocstoreManager.promises.getDoc.mockResolvedValue({
        lines: ['\\documentclass{article}', 'Overleaf local edit'],
        rev: 2,
      })

      // Drive's checksum is unchanged from the last sync - Drive was never
      // touched, only Overleaf was.
      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [
          {
            id: 'drive-main-1',
            name: 'main.tex',
            mimeType: 'text/plain',
            md5Checksum: 'chk1',
          },
        ],
        nextPageToken: null,
      })
      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('\\documentclass{article}\nOld synced content', 'utf8')
      )
      GoogleDriveClient.uploadFile.mockResolvedValue({
        id: 'drive-main-1',
        md5Checksum: 'chk_new_pushed',
        modifiedTime: '2026-09-02T10:00:00Z',
      })

      const res = await GoogleDriveSyncManager.syncProject(projectId, userId)

      expect(res.success).toBe(true)
      expect(GoogleDriveClient.uploadFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'main.tex',
        expect.anything(),
        'text/plain',
        'drive-main-1'
      )
      expect(EditorController.promises.upsertDocWithPath).not.toHaveBeenCalled()

      const updateCall = db.googleDriveProjectStates.updateOne.mock.calls.find(
        call => call[1]?.$set?.fileMap?.['main.tex'] !== undefined
      )
      expect(updateCall[1].$set.fileMap['main.tex'].md5Checksum).toBe(
        'chk_new_pushed'
      )
    })

    it('never destructively overwrites live Overleaf content when it is not confirmed that Drive actually changed', async function () {
      // Reproduces the state left behind by an earlier conflict: fileMap's
      // rev already matches Overleaf's current rev (so
      // overleafModifiedSinceSync reads false) and its md5Checksum already
      // matches Drive's current checksum (so driveModifiedSinceSync also
      // reads false) - yet the actual content still differs, because the
      // conflict branch never pushed Overleaf's content to Drive, it only
      // recorded bookkeeping. With neither flag confirming a change, this
      // must never fall through to "Drive wins" and clobber the live doc.
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'My Project',
        owner_ref: new MockObjectId(userId),
      })

      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        projectFolderId
      )

      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        userId: new MockObjectId(userId),
        driveFolderId: projectFolderId,
        fileMap: {
          'main.tex': {
            driveFileId: 'drive-main-1',
            rev: 2, // already matches Overleaf's current rev below
            md5Checksum: 'chk_unchanged', // already matches Drive's current checksum below
          },
        },
      })

      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [
          {
            path: '/main.tex',
            doc: { _id: new MockObjectId(docId), name: 'main.tex' },
          },
        ],
        files: [],
      })
      DocstoreManager.promises.getAllDocs.mockResolvedValue([
        {
          _id: docId,
          lines: ['\\documentclass{article}', 'Live Overleaf content'],
          rev: 2,
        },
      ])
      DocstoreManager.promises.getDoc.mockResolvedValue({
        lines: ['\\documentclass{article}', 'Live Overleaf content'],
        rev: 2,
      })

      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [
          {
            id: 'drive-main-1',
            name: 'main.tex',
            mimeType: 'text/plain',
            md5Checksum: 'chk_unchanged',
          },
        ],
        nextPageToken: null,
      })
      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('\\documentclass{article}\nStale Drive content', 'utf8')
      )
      GoogleDriveClient.uploadFile.mockResolvedValue({
        id: 'drive-main-1',
        md5Checksum: 'chk_pushed_now',
        modifiedTime: '2026-09-02T11:00:00Z',
      })

      const res = await GoogleDriveSyncManager.syncProject(projectId, userId)

      expect(res.success).toBe(true)
      expect(EditorController.promises.upsertDocWithPath).not.toHaveBeenCalled()
    })

    it('pushes a binary file to Google Drive instead of silently skipping it, when only Overleaf changed since the last sync', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'My Project',
        owner_ref: new MockObjectId(userId),
      })

      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        projectFolderId
      )

      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        userId: new MockObjectId(userId),
        driveFolderId: projectFolderId,
        fileMap: {
          'logo.png': {
            driveFileId: 'drive-file-png',
            md5Checksum: 'pngmd5-old',
            overleafHash: 'ov-hash-old',
            entityType: 'file',
          },
        },
      })

      // Overleaf's file hash changed (re-uploaded), Drive's is untouched.
      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [
          {
            path: '/logo.png',
            file: { _id: fileId, name: 'logo.png', hash: 'ov-hash-new' },
          },
        ],
      })
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])

      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [
          {
            id: 'drive-file-png',
            name: 'logo.png',
            mimeType: 'image/png',
            md5Checksum: 'pngmd5-old',
          },
        ],
        nextPageToken: null,
      })

      HistoryManager.promises.requestBlobWithProjectId.mockResolvedValue({
        stream: Buffer.from('NEWPNGDATA'),
      })
      GoogleDriveClient.uploadFile.mockResolvedValue({
        id: 'drive-file-png',
        md5Checksum: 'pngmd5-new',
        modifiedTime: '2026-09-02T10:00:00Z',
      })

      const res = await GoogleDriveSyncManager.syncProject(projectId, userId)

      expect(res.success).toBe(true)
      expect(GoogleDriveClient.uploadFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'logo.png',
        expect.anything(),
        'image/png',
        'drive-file-png'
      )
      expect(
        EditorController.promises.upsertFileWithPath
      ).not.toHaveBeenCalled()

      const updateCall = db.googleDriveProjectStates.updateOne.mock.calls.find(
        call => call[1]?.$set?.fileMap?.['logo.png'] !== undefined
      )
      expect(updateCall[1].$set.fileMap['logo.png'].md5Checksum).toBe(
        'pngmd5-new'
      )
    })

    it('imports new binary file and text file from Google Drive into Overleaf', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'My Project',
        owner_ref: new MockObjectId(userId),
      })

      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        projectFolderId
      )

      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        userId: new MockObjectId(userId),
        driveFolderId: projectFolderId,
        fileMap: {},
      })

      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [],
      })
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])

      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [
          {
            id: 'drive-file-png',
            name: 'logo.png',
            mimeType: 'image/png',
            md5Checksum: 'pngmd5',
          },
          {
            id: 'drive-doc-bib',
            name: 'references.bib',
            mimeType: 'text/plain',
            md5Checksum: 'bibmd5',
          },
        ],
        nextPageToken: null,
      })

      GoogleDriveClient.downloadFileBuffer.mockImplementation((uId, fileId) => {
        if (fileId === 'drive-file-png')
          return Promise.resolve(Buffer.from('PNGDATA'))
        return Promise.resolve(Buffer.from('@article{test, author={Test}}'))
      })

      EditorController.promises.upsertFileWithPath.mockResolvedValue({
        file: {},
      })
      EditorController.promises.upsertDocWithPath.mockResolvedValue({
        doc: {},
      })

      const res = await GoogleDriveSyncManager.syncProject(projectId, userId)

      expect(res.success).toBe(true)
      expect(EditorController.promises.upsertFileWithPath).toHaveBeenCalledWith(
        projectId,
        '/logo.png',
        expect.any(String),
        null,
        'google-drive',
        userId
      )
      expect(EditorController.promises.upsertDocWithPath).toHaveBeenCalledWith(
        projectId,
        '/references.bib',
        ['@article{test, author={Test}}'],
        'google-drive',
        userId
      )
    })

    it('deletes the file from Google Drive instead of resurrecting it in Overleaf, when a previously-synced file was deleted locally', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'My Project',
        owner_ref: new MockObjectId(userId),
      })

      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        projectFolderId
      )

      // Previously synced: fileMap already knows about this path/driveFileId
      // from an earlier sync.
      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        userId: new MockObjectId(userId),
        driveFolderId: projectFolderId,
        fileMap: {
          'main (Google Drive Conflict 2026-09-01-2205).tex': {
            driveFileId: 'drive-conflict-file-1',
            md5Checksum: 'conflictmd5',
            rev: 1,
          },
        },
      })

      // The user deleted it in Overleaf, so it's no longer among the
      // project's entities.
      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [],
      })
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])

      // But it's still sitting in Drive, unchanged since last sync.
      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [
          {
            id: 'drive-conflict-file-1',
            name: 'main (Google Drive Conflict 2026-09-01-2205).tex',
            mimeType: 'text/plain',
            md5Checksum: 'conflictmd5',
          },
        ],
        nextPageToken: null,
      })

      const res = await GoogleDriveSyncManager.syncProject(projectId, userId)

      expect(res.success).toBe(true)
      expect(GoogleDriveClient.deleteFile).toHaveBeenCalledWith(
        userId,
        'drive-conflict-file-1'
      )
      expect(EditorController.promises.upsertDocWithPath).not.toHaveBeenCalled()
      expect(
        EditorController.promises.upsertFileWithPath
      ).not.toHaveBeenCalled()

      const updateCall = db.googleDriveProjectStates.updateOne.mock.calls.find(
        call => call[1]?.$set?.fileMap !== undefined
      )
      expect(
        updateCall[1].$set.fileMap[
          'main (Google Drive Conflict 2026-09-01-2205).tex'
        ]
      ).toBeUndefined()
    })

    it('deletes entity in Overleaf if it was previously synced but removed from Drive', async function () {
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'My Project',
        owner_ref: new MockObjectId(userId),
      })

      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        projectFolderId
      )

      db.googleDriveProjectStates.findOne.mockResolvedValue({
        projectId: new MockObjectId(projectId),
        userId: new MockObjectId(userId),
        driveFolderId: projectFolderId,
        fileMap: {
          'deleted.tex': {
            driveFileId: 'deleted-drive-file',
            rev: 1,
          },
        },
      })

      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [
          {
            path: '/deleted.tex',
            doc: { _id: new MockObjectId(docId), name: 'deleted.tex' },
          },
        ],
        files: [],
      })
      DocstoreManager.promises.getAllDocs.mockResolvedValue([
        { _id: docId, lines: ['Content'], rev: 1 },
      ])

      // Drive has no files
      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [],
        nextPageToken: null,
      })

      EditorController.promises.deleteEntityWithPath.mockResolvedValue(true)

      const res = await GoogleDriveSyncManager.syncProject(projectId, userId)

      expect(res.success).toBe(true)
      expect(
        EditorController.promises.deleteEntityWithPath
      ).toHaveBeenCalledWith(projectId, '/deleted.tex', 'google-drive', userId)
    })
  })

  describe('Incremental Polling: pollUserChanges', function () {
    it('returns unlinked if user has no credentials', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue(null)

      const result = await GoogleDriveSyncManager.pollUserChanges(userId)
      expect(result).toEqual({ unlinked: true })
    })

    it('initializes startPageToken if credentials do not have one', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: null,
      })

      GoogleDriveClient.getStartPageToken.mockResolvedValue('token-12345')

      const result = await GoogleDriveSyncManager.pollUserChanges(userId)
      expect(result).toEqual({
        initialized: true,
        startPageToken: 'token-12345',
      })
      expect(GoogleDriveClient.getStartPageToken).toHaveBeenCalledWith(userId)
    })

    it('handles empty changes list gracefully and updates startPageToken', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: 'token-100',
      })

      GoogleDriveClient.getChanges.mockResolvedValue({
        changes: [],
        nextPageToken: null,
        newStartPageToken: 'token-105',
      })

      const res = await GoogleDriveSyncManager.pollUserChanges(userId)

      expect(res).toEqual({
        success: true,
        processedCount: 0,
        newStartPageToken: 'token-105',
      })
      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledWith(
        { user_id: expect.anything() },
        {
          $set: {
            startPageToken: 'token-105',
            updatedAt: expect.any(Date),
          },
        }
      )
    })

    it('creates new project when a new folder is created in Overleaf root', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: 'token-123',
      })

      GoogleDriveClient.getChanges.mockResolvedValue({
        changes: [
          {
            fileId: 'new-folder-id-888',
            removed: false,
            file: {
              id: 'new-folder-id-888',
              name: 'New Research Paper',
              mimeType: 'application/vnd.google-apps.folder',
              parents: [rootFolderId],
              trashed: false,
            },
          },
        ],
        nextPageToken: null,
        newStartPageToken: 'token-124',
      })

      const cursorMock = {
        toArray: vi.fn().mockResolvedValue([]),
      }
      db.googleDriveProjectStates.find.mockReturnValue(cursorMock)

      ProjectCreationHandler.promises.createBlankProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'New Research Paper',
      })

      db.googleDriveProjectStates.insertOne.mockResolvedValue({
        insertedId: projectId,
      })
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'New Research Paper',
        owner_ref: new MockObjectId(userId),
      })
      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
        'new-folder-id-888'
      )
      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [],
      })
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])
      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [],
        nextPageToken: null,
      })

      const res = await GoogleDriveSyncManager.pollUserChanges(userId)

      expect(res.success).toBe(true)
      expect(
        ProjectCreationHandler.promises.createBlankProject
      ).toHaveBeenCalledWith(userId, 'New Research Paper')
      expect(db.googleDriveUserCredentials.updateOne).toHaveBeenCalledWith(
        { user_id: expect.anything() },
        {
          $set: {
            startPageToken: 'token-124',
            updatedAt: expect.any(Date),
          },
        }
      )
    })

    it('clears entities in Overleaf when project folder is deleted in Drive', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: 'token-123',
      })

      GoogleDriveClient.getChanges.mockResolvedValue({
        changes: [
          {
            fileId: projectFolderId,
            removed: true,
            file: {
              id: projectFolderId,
              name: 'Deleted Project Folder',
              mimeType: 'application/vnd.google-apps.folder',
              parents: [rootFolderId],
              trashed: true,
            },
          },
        ],
        nextPageToken: null,
        newStartPageToken: 'token-125',
      })

      const cursorMock = {
        toArray: vi.fn().mockResolvedValue([
          {
            projectId: new MockObjectId(projectId),
            userId: new MockObjectId(userId),
            driveFolderId: projectFolderId,
            folderName: 'Deleted Project Folder',
            fileMap: {},
          },
        ]),
      }
      db.googleDriveProjectStates.find.mockReturnValue(cursorMock)

      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [
          {
            path: '/main.tex',
            doc: { _id: new MockObjectId(docId), name: 'main.tex' },
          },
        ],
        files: [
          {
            path: '/figure.png',
            file: { _id: new MockObjectId(fileId), name: 'figure.png' },
          },
        ],
      })

      EditorController.promises.deleteEntityWithPath.mockResolvedValue(true)
      db.googleDriveProjectStates.updateOne.mockResolvedValue({
        modifiedCount: 1,
      })

      const res = await GoogleDriveSyncManager.pollUserChanges(userId)

      expect(res.success).toBe(true)
      expect(
        EditorController.promises.deleteEntityWithPath
      ).toHaveBeenCalledWith(
        expect.anything(),
        '/main.tex',
        'google-drive',
        userId
      )
      expect(
        EditorController.promises.deleteEntityWithPath
      ).toHaveBeenCalledWith(
        expect.anything(),
        '/figure.png',
        'google-drive',
        userId
      )
    })

    it('applies doc updates and deletions from incremental changes', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: 'token-100',
      })

      GoogleDriveClient.getChanges.mockResolvedValue({
        changes: [
          {
            fileId: 'file-doc-1',
            removed: false,
            file: {
              id: 'file-doc-1',
              name: 'section1.tex',
              mimeType: 'text/plain',
              parents: [projectFolderId],
              trashed: false,
            },
          },
          {
            fileId: 'file-doc-old',
            removed: true,
          },
        ],
        nextPageToken: null,
        newStartPageToken: 'token-101',
      })

      const cursorMock = {
        toArray: vi.fn().mockResolvedValue([
          {
            projectId: new MockObjectId(projectId),
            userId: new MockObjectId(userId),
            driveFolderId: projectFolderId,
            folderName: 'My Project',
            fileMap: {
              'old-section.tex': {
                driveFileId: 'file-doc-old',
              },
            },
          },
        ]),
      }
      db.googleDriveProjectStates.find.mockReturnValue(cursorMock)

      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('New section content', 'utf8')
      )
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])
      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [],
      })
      EditorController.promises.upsertDocWithPath.mockResolvedValue({
        doc: { _id: docId, rev: 8 },
      })
      EditorController.promises.deleteEntityWithPath.mockResolvedValue(true)

      const res = await GoogleDriveSyncManager.pollUserChanges(userId)

      expect(res.success).toBe(true)
      expect(EditorController.promises.upsertDocWithPath).toHaveBeenCalledWith(
        expect.anything(),
        '/section1.tex',
        ['New section content'],
        'google-drive',
        userId
      )
      expect(
        EditorController.promises.deleteEntityWithPath
      ).toHaveBeenCalledWith(
        expect.anything(),
        '/old-section.tex',
        'google-drive',
        userId
      )
      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        { projectId: expect.anything() },
        expect.objectContaining({
          $set: expect.objectContaining({
            fileMap: expect.objectContaining({
              'section1.tex': expect.objectContaining({
                rev: 8,
              }),
            }),
          }),
        })
      )
    })

    it('resolves nested subfolder paths when a new file is added inside a subfolder', async function () {
      const subfolderId = 'subfolder-id-777'

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: 'token-500',
      })

      GoogleDriveClient.getChanges.mockResolvedValue({
        changes: [
          {
            fileId: 'new-nested-file-id',
            removed: false,
            file: {
              id: 'new-nested-file-id',
              name: 'intro.tex',
              mimeType: 'text/plain',
              parents: [subfolderId],
              trashed: false,
            },
          },
        ],
        nextPageToken: null,
        newStartPageToken: 'token-501',
      })

      const cursorMock = {
        toArray: vi.fn().mockResolvedValue([
          {
            projectId: new MockObjectId(projectId),
            userId: new MockObjectId(userId),
            driveFolderId: projectFolderId,
            folderName: 'My Project',
            folderMap: {
              [subfolderId]: 'chapters',
            },
            fileMap: {},
          },
        ]),
      }
      db.googleDriveProjectStates.find.mockReturnValue(cursorMock)

      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('\\section{Introduction}', 'utf8')
      )
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])
      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [],
      })
      EditorController.promises.upsertDocWithPath.mockResolvedValue({
        doc: { _id: 'doc-intro-id', rev: 1 },
      })

      const res = await GoogleDriveSyncManager.pollUserChanges(userId)

      expect(res.success).toBe(true)
      expect(EditorController.promises.upsertDocWithPath).toHaveBeenCalledWith(
        expect.anything(),
        '/chapters/intro.tex',
        ['\\section{Introduction}'],
        'google-drive',
        userId
      )
      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        { projectId: expect.anything() },
        expect.objectContaining({
          $set: expect.objectContaining({
            fileMap: expect.objectContaining({
              'chapters/intro.tex': expect.objectContaining({
                driveFileId: 'new-nested-file-id',
                rev: 1,
              }),
            }),
          }),
        })
      )
    })

    it('dynamically discovers unknown parent subfolder hierarchy using GoogleDriveClient.getFileMetadata', async function () {
      const unknownSubfolderId = 'unknown-subfolder-999'

      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: 'token-600',
      })

      GoogleDriveClient.getChanges.mockResolvedValue({
        changes: [
          {
            fileId: 'nested-fig-id',
            removed: false,
            file: {
              id: 'nested-fig-id',
              name: 'diagram.png',
              mimeType: 'image/png',
              parents: [unknownSubfolderId],
              trashed: false,
              md5Checksum: 'diagmd5',
            },
          },
        ],
        nextPageToken: null,
        newStartPageToken: 'token-601',
      })

      const cursorMock = {
        toArray: vi.fn().mockResolvedValue([
          {
            projectId: new MockObjectId(projectId),
            userId: new MockObjectId(userId),
            driveFolderId: projectFolderId,
            folderName: 'My Project',
            folderMap: {},
            fileMap: {},
          },
        ]),
      }
      db.googleDriveProjectStates.find.mockReturnValue(cursorMock)

      GoogleDriveClient.getFileMetadata.mockResolvedValue({
        id: unknownSubfolderId,
        name: 'figures',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [projectFolderId],
        trashed: false,
      })

      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('PNG_BYTES')
      )
      EditorController.promises.upsertFileWithPath.mockResolvedValue(true)

      const res = await GoogleDriveSyncManager.pollUserChanges(userId)

      expect(res.success).toBe(true)
      expect(GoogleDriveClient.getFileMetadata).toHaveBeenCalledWith(
        userId,
        unknownSubfolderId,
        'id,name,mimeType,parents,trashed'
      )
      expect(EditorController.promises.upsertFileWithPath).toHaveBeenCalledWith(
        expect.anything(),
        '/figures/diagram.png',
        expect.any(String),
        null,
        'google-drive',
        userId
      )
    })

    it('applies binary file updates from incremental changes', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: 'token-200',
      })

      GoogleDriveClient.getChanges.mockResolvedValue({
        changes: [
          {
            fileId: 'file-img-1',
            removed: false,
            file: {
              id: 'file-img-1',
              name: 'plot.png',
              mimeType: 'image/png',
              parents: [projectFolderId],
              trashed: false,
              md5Checksum: 'newpngmd5',
            },
          },
        ],
        nextPageToken: null,
        newStartPageToken: 'token-201',
      })

      const cursorMock = {
        toArray: vi.fn().mockResolvedValue([
          {
            projectId: new MockObjectId(projectId),
            userId: new MockObjectId(userId),
            driveFolderId: projectFolderId,
            folderName: 'My Project',
            fileMap: {},
          },
        ]),
      }
      db.googleDriveProjectStates.find.mockReturnValue(cursorMock)

      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('PNG_BYTES')
      )
      EditorController.promises.upsertFileWithPath.mockResolvedValue(true)

      const res = await GoogleDriveSyncManager.pollUserChanges(userId)

      expect(res.success).toBe(true)
      expect(EditorController.promises.upsertFileWithPath).toHaveBeenCalledWith(
        expect.anything(),
        '/plot.png',
        expect.any(String),
        null,
        'google-drive',
        userId
      )
    })

    it('creates conflict copy during poll changes when doc is concurrently modified', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: 'token-300',
      })

      GoogleDriveClient.getChanges.mockResolvedValue({
        changes: [
          {
            fileId: 'file-doc-conflicting',
            removed: false,
            file: {
              id: 'file-doc-conflicting',
              name: 'main.tex',
              mimeType: 'text/plain',
              parents: [projectFolderId],
              trashed: false,
            },
          },
        ],
        nextPageToken: null,
        newStartPageToken: 'token-301',
      })

      const cursorMock = {
        toArray: vi.fn().mockResolvedValue([
          {
            projectId: new MockObjectId(projectId),
            userId: new MockObjectId(userId),
            driveFolderId: projectFolderId,
            folderName: 'My Project',
            fileMap: {
              'main.tex': {
                driveFileId: 'file-doc-conflicting',
                rev: 1, // last synced rev was 1
              },
            },
          },
        ]),
      }
      db.googleDriveProjectStates.find.mockReturnValue(cursorMock)

      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('Drive remote edits', 'utf8')
      )
      DocstoreManager.promises.getAllDocs.mockResolvedValue([
        {
          _id: docId,
          lines: ['Overleaf local concurrent edits'],
          rev: 4, // local rev bumped to 4
        },
      ])
      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [
          {
            path: '/main.tex',
            doc: { _id: new MockObjectId(docId), name: 'main.tex' },
          },
        ],
        files: [],
      })
      EditorController.promises.upsertDocWithPath.mockResolvedValue(true)

      const res = await GoogleDriveSyncManager.pollUserChanges(userId)

      expect(res.success).toBe(true)
      expect(
        EditorController.promises.upsertDocWithPath
      ).not.toHaveBeenCalledWith(
        expect.anything(),
        '/main.tex',
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
      expect(EditorController.promises.upsertDocWithPath).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/^\/main \(Google Drive Conflict .*\)\.tex$/),
        ['Drive remote edits'],
        'google-drive',
        userId
      )
      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        { projectId: expect.anything() },
        expect.objectContaining({
          $push: {
            conflicts: {
              $each: [
                expect.objectContaining({
                  path: 'main.tex',
                  conflictPath: expect.stringMatching(
                    /^main \(Google Drive Conflict .*\)\.tex$/
                  ),
                  detectedAt: expect.any(Date),
                }),
              ],
              $slice: -20,
            },
          },
        })
      )
    })

    it('creates conflict copy during poll changes when binary file is concurrently modified', async function () {
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: 'token-300',
      })

      GoogleDriveClient.getChanges.mockResolvedValue({
        changes: [
          {
            fileId: 'file-img-conflicting',
            removed: false,
            file: {
              id: 'file-img-conflicting',
              name: 'diagram.png',
              mimeType: 'image/png',
              parents: [projectFolderId],
              trashed: false,
              md5Checksum: 'drive-diag-md5-new',
            },
          },
        ],
        nextPageToken: null,
        newStartPageToken: 'token-301',
      })

      const cursorMock = {
        toArray: vi.fn().mockResolvedValue([
          {
            projectId: new MockObjectId(projectId),
            userId: new MockObjectId(userId),
            driveFolderId: projectFolderId,
            folderName: 'My Project',
            fileMap: {
              'diagram.png': {
                driveFileId: 'file-img-conflicting',
                md5Checksum: 'diag-md5-old',
                overleafHash: 'ov-diag-hash-old',
                entityType: 'file',
              },
            },
          },
        ]),
      }
      db.googleDriveProjectStates.find.mockReturnValue(cursorMock)

      GoogleDriveClient.downloadFileBuffer.mockResolvedValue(
        Buffer.from('Drive remote png edits')
      )
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])
      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [
          {
            path: '/diagram.png',
            file: {
              _id: new MockObjectId(fileId),
              name: 'diagram.png',
              hash: 'ov-diag-hash-new',
            },
          },
        ],
      })
      EditorController.promises.upsertFileWithPath.mockResolvedValue(true)

      const res = await GoogleDriveSyncManager.pollUserChanges(userId)

      expect(res.success).toBe(true)
      expect(
        EditorController.promises.upsertFileWithPath
      ).not.toHaveBeenCalledWith(
        expect.anything(),
        '/diagram.png',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
      expect(EditorController.promises.upsertFileWithPath).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/^\/diagram \(Google Drive Conflict .*\)\.png$/),
        expect.any(String),
        null,
        'google-drive',
        userId
      )
      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        { projectId: expect.anything() },
        expect.objectContaining({
          $push: {
            conflicts: {
              $each: [
                expect.objectContaining({
                  path: 'diagram.png',
                  conflictPath: expect.stringMatching(
                    /^diagram \(Google Drive Conflict .*\)\.png$/
                  ),
                  detectedAt: expect.any(Date),
                }),
              ],
              $slice: -20,
            },
          },
        })
      )
    })

    it('ignores a Drive change event whose checksum already matches the last-synced state, instead of re-fetching or misreading it as a conflict', async function () {
      // This is what happens right after our own outbound push updates a
      // file on Drive: the Changes API reports a real change (Drive's
      // content genuinely did change), but it's just an echo of a write we
      // ourselves just made - already fully reflected in fileMap. Without
      // this check, the very next poll re-processes it as if it were a
      // fresh Drive-side edit, and if Overleaf's rev has moved on since,
      // misclassifies it as a concurrent-edit conflict.
      db.googleDriveUserCredentials.findOne.mockResolvedValue({
        user_id: new MockObjectId(userId),
        rootFolderId,
        startPageToken: 'token-400',
      })

      GoogleDriveClient.getChanges.mockResolvedValue({
        changes: [
          {
            fileId: 'file-doc-echo',
            removed: false,
            file: {
              id: 'file-doc-echo',
              name: 'main.tex',
              mimeType: 'text/plain',
              parents: [projectFolderId],
              trashed: false,
              md5Checksum: 'chk_pushed_by_us',
            },
          },
        ],
        nextPageToken: null,
        newStartPageToken: 'token-401',
      })

      const cursorMock = {
        toArray: vi.fn().mockResolvedValue([
          {
            projectId: new MockObjectId(projectId),
            userId: new MockObjectId(userId),
            driveFolderId: projectFolderId,
            folderName: 'My Project',
            fileMap: {
              'main.tex': {
                driveFileId: 'file-doc-echo',
                rev: 4,
                md5Checksum: 'chk_pushed_by_us',
              },
            },
          },
        ]),
      }
      db.googleDriveProjectStates.find.mockReturnValue(cursorMock)

      const res = await GoogleDriveSyncManager.pollUserChanges(userId)

      expect(res.success).toBe(true)
      expect(GoogleDriveClient.downloadFileBuffer).not.toHaveBeenCalled()
      expect(EditorController.promises.upsertDocWithPath).not.toHaveBeenCalled()
    })

    describe('rename and move by stable Drive file ID', function () {
      it('calls renameEntity with entity ID and new name without deleting when filename changed in same folder', async function () {
        const stableFileId = 'stable-drive-doc-1'
        db.googleDriveUserCredentials.findOne.mockResolvedValue({
          user_id: new MockObjectId(userId),
          rootFolderId,
          startPageToken: 'token-700',
        })

        GoogleDriveClient.getChanges.mockResolvedValue({
          changes: [
            {
              fileId: stableFileId,
              removed: false,
              file: {
                id: stableFileId,
                name: 'renamed_main.tex',
                mimeType: 'text/plain',
                parents: [projectFolderId],
                trashed: false,
                md5Checksum: 'chk1',
              },
            },
          ],
          nextPageToken: null,
          newStartPageToken: 'token-701',
        })

        const cursorMock = {
          toArray: vi.fn().mockResolvedValue([
            {
              projectId: new MockObjectId(projectId),
              userId: new MockObjectId(userId),
              driveFolderId: projectFolderId,
              folderName: 'My Project',
              fileMap: {
                'main.tex': {
                  driveFileId: stableFileId,
                  entityId: new MockObjectId(docId),
                  entityType: 'doc',
                  rev: 2,
                  md5Checksum: 'chk1',
                },
              },
            },
          ]),
        }
        db.googleDriveProjectStates.find.mockReturnValue(cursorMock)
        EditorController.promises.renameEntity.mockResolvedValue(true)

        const res = await GoogleDriveSyncManager.pollUserChanges(userId)

        expect(res.success).toBe(true)
        expect(EditorController.promises.renameEntity).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'doc',
          'renamed_main.tex',
          userId,
          'google-drive'
        )
        expect(
          EditorController.promises.deleteEntityWithPath
        ).not.toHaveBeenCalled()

        const updateCall =
          db.googleDriveProjectStates.updateOne.mock.calls.find(
            call => call[1]?.$set?.fileMap !== undefined
          )
        expect(updateCall).toBeDefined()
        expect(updateCall[1].$set.fileMap['main.tex']).toBeUndefined()
        expect(updateCall[1].$set.fileMap['renamed_main.tex']).toEqual(
          expect.objectContaining({
            driveFileId: stableFileId,
            entityType: 'doc',
            md5Checksum: 'chk1',
          })
        )
      })

      it('calls moveEntity with new parent folder ID without deleting when parent folder changed', async function () {
        const stableFileId = 'stable-drive-doc-2'
        const oldSubfolderId = 'subfolder-old-777'
        const newSubfolderId = 'subfolder-new-888'

        db.googleDriveUserCredentials.findOne.mockResolvedValue({
          user_id: new MockObjectId(userId),
          rootFolderId,
          startPageToken: 'token-710',
        })

        GoogleDriveClient.getChanges.mockResolvedValue({
          changes: [
            {
              fileId: stableFileId,
              removed: false,
              file: {
                id: stableFileId,
                name: 'intro.tex',
                mimeType: 'text/plain',
                parents: [newSubfolderId],
                trashed: false,
                md5Checksum: 'chk2',
              },
            },
          ],
          nextPageToken: null,
          newStartPageToken: 'token-711',
        })

        const cursorMock = {
          toArray: vi.fn().mockResolvedValue([
            {
              projectId: new MockObjectId(projectId),
              userId: new MockObjectId(userId),
              driveFolderId: projectFolderId,
              folderName: 'My Project',
              folderMap: {
                [oldSubfolderId]: 'chapters',
                [newSubfolderId]: 'sections',
              },
              fileMap: {
                'chapters/intro.tex': {
                  driveFileId: stableFileId,
                  entityId: new MockObjectId(docId),
                  entityType: 'doc',
                  rev: 1,
                  md5Checksum: 'chk2',
                },
              },
            },
          ]),
        }
        db.googleDriveProjectStates.find.mockReturnValue(cursorMock)
        EditorController.promises.mkdirp.mockResolvedValue({
          lastFolder: { _id: 'new-folder-sections-id' },
          newFolders: [],
        })
        EditorController.promises.moveEntity.mockResolvedValue(true)

        const res = await GoogleDriveSyncManager.pollUserChanges(userId)

        expect(res.success).toBe(true)
        expect(EditorController.promises.moveEntity).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'new-folder-sections-id',
          'doc',
          userId,
          'google-drive'
        )
        expect(
          EditorController.promises.deleteEntityWithPath
        ).not.toHaveBeenCalled()

        const updateCall =
          db.googleDriveProjectStates.updateOne.mock.calls.find(
            call => call[1]?.$set?.fileMap !== undefined
          )
        expect(updateCall).toBeDefined()
        expect(updateCall[1].$set.fileMap['chapters/intro.tex']).toBeUndefined()
        expect(updateCall[1].$set.fileMap['sections/intro.tex']).toEqual(
          expect.objectContaining({
            driveFileId: stableFileId,
            entityType: 'doc',
            md5Checksum: 'chk2',
          })
        )
      })

      it('rekeys fileMap with driveFileId, entityId, and entityType intact when both folder and name change', async function () {
        const stableFileId = 'stable-drive-bin-3'
        const oldSubfolderId = 'subfolder-figs-111'
        const newSubfolderId = 'subfolder-assets-222'

        db.googleDriveUserCredentials.findOne.mockResolvedValue({
          user_id: new MockObjectId(userId),
          rootFolderId,
          startPageToken: 'token-720',
        })

        GoogleDriveClient.getChanges.mockResolvedValue({
          changes: [
            {
              fileId: stableFileId,
              removed: false,
              file: {
                id: stableFileId,
                name: 'new_diagram.png',
                mimeType: 'image/png',
                parents: [newSubfolderId],
                trashed: false,
                md5Checksum: 'binchk3',
              },
            },
          ],
          nextPageToken: null,
          newStartPageToken: 'token-721',
        })

        const cursorMock = {
          toArray: vi.fn().mockResolvedValue([
            {
              projectId: new MockObjectId(projectId),
              userId: new MockObjectId(userId),
              driveFolderId: projectFolderId,
              folderName: 'My Project',
              folderMap: {
                [oldSubfolderId]: 'figures',
                [newSubfolderId]: 'assets',
              },
              fileMap: {
                'figures/old_diagram.png': {
                  driveFileId: stableFileId,
                  entityId: new MockObjectId(fileId),
                  entityType: 'file',
                  overleafHash: 'hash-abc',
                  md5Checksum: 'binchk3',
                },
              },
            },
          ]),
        }
        db.googleDriveProjectStates.find.mockReturnValue(cursorMock)
        EditorController.promises.mkdirp.mockResolvedValue({
          lastFolder: { _id: 'new-folder-assets-id' },
          newFolders: [],
        })
        EditorController.promises.moveEntity.mockResolvedValue(true)
        EditorController.promises.renameEntity.mockResolvedValue(true)

        const res = await GoogleDriveSyncManager.pollUserChanges(userId)

        expect(res.success).toBe(true)
        expect(EditorController.promises.moveEntity).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'new-folder-assets-id',
          'file',
          userId,
          'google-drive'
        )
        expect(EditorController.promises.renameEntity).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          'file',
          'new_diagram.png',
          userId,
          'google-drive'
        )
        expect(
          EditorController.promises.deleteEntityWithPath
        ).not.toHaveBeenCalled()

        const updateCall =
          db.googleDriveProjectStates.updateOne.mock.calls.find(
            call => call[1]?.$set?.fileMap !== undefined
          )
        expect(updateCall).toBeDefined()
        expect(
          updateCall[1].$set.fileMap['figures/old_diagram.png']
        ).toBeUndefined()
        expect(updateCall[1].$set.fileMap['assets/new_diagram.png']).toEqual(
          expect.objectContaining({
            driveFileId: stableFileId,
            entityType: 'file',
            md5Checksum: 'binchk3',
          })
        )
      })
    })
  })

  describe('reconcileExistingDriveProjects', function () {
    beforeEach(function () {
      GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
      db.googleDriveProjectStates.find.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      })
    })

    it('reports zero scanned/created when the root folder has no subfolders', async function () {
      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [],
        nextPageToken: null,
      })

      const result =
        await GoogleDriveSyncManager.reconcileExistingDriveProjects(userId)

      expect(result).toEqual({
        scannedCount: 0,
        createdCount: 0,
        createdProjects: [],
        syncedCount: 0,
        syncedProjects: [],
      })
      expect(
        ProjectCreationHandler.promises.createBlankProject
      ).not.toHaveBeenCalled()
    })

    it('creates a project for each subfolder with no matching sync state', async function () {
      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [
          { id: 'folder-a', name: 'Paper A', trashed: false },
          { id: 'folder-b', name: 'Paper B', trashed: false },
        ],
        nextPageToken: null,
      })
      ProjectCreationHandler.promises.createBlankProject
        .mockResolvedValueOnce({
          _id: new MockObjectId('folder-a-project'),
          name: 'Paper A',
        })
        .mockResolvedValueOnce({
          _id: new MockObjectId('folder-b-project'),
          name: 'Paper B',
        })
      db.googleDriveProjectStates.insertOne.mockResolvedValue({
        insertedId: 'x',
      })
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'Paper A',
        owner_ref: new MockObjectId(userId),
      })
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue('folder-a')
      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [],
      })
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])

      const result =
        await GoogleDriveSyncManager.reconcileExistingDriveProjects(userId)

      expect(result.scannedCount).toBe(2)
      expect(result.createdCount).toBe(2)
      expect(result.createdProjects).toEqual([
        { projectId: expect.anything(), name: 'Paper A' },
        { projectId: expect.anything(), name: 'Paper B' },
      ])
      expect(
        ProjectCreationHandler.promises.createBlankProject
      ).toHaveBeenCalledWith(userId, 'Paper A')
      expect(
        ProjectCreationHandler.promises.createBlankProject
      ).toHaveBeenCalledWith(userId, 'Paper B')
    })

    it('skips a subfolder that already has a matching googleDriveProjectStates doc', async function () {
      db.googleDriveProjectStates.find.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          {
            projectId: new MockObjectId(projectId),
            userId: new MockObjectId(userId),
            driveFolderId: 'folder-a',
            folderName: 'Paper A',
          },
        ]),
      })
      GoogleDriveClient.listFiles.mockResolvedValue({
        files: [{ id: 'folder-a', name: 'Paper A', trashed: false }],
        nextPageToken: null,
      })

      const result =
        await GoogleDriveSyncManager.reconcileExistingDriveProjects(userId)

      expect(result).toEqual({
        scannedCount: 1,
        createdCount: 0,
        createdProjects: [],
        syncedCount: 0,
        syncedProjects: [],
      })
      expect(
        ProjectCreationHandler.promises.createBlankProject
      ).not.toHaveBeenCalled()
    })

    it('follows pagination to scan every page of subfolders', async function () {
      // reconcileExistingDriveProjects's own root-folder scan is paginated
      // here; syncProject (run internally for each newly created project)
      // also calls listFiles to pull the new project's contents, against a
      // different folder id, so branch on the query rather than call order.
      GoogleDriveClient.listFiles.mockImplementation(
        async (_userId, query, _fields, pageToken) => {
          if (query.includes(rootFolderId)) {
            if (!pageToken) {
              return {
                files: [{ id: 'folder-a', name: 'Paper A', trashed: false }],
                nextPageToken: 'page-2',
              }
            }
            return {
              files: [{ id: 'folder-b', name: 'Paper B', trashed: false }],
              nextPageToken: null,
            }
          }
          return { files: [], nextPageToken: null }
        }
      )
      ProjectCreationHandler.promises.createBlankProject
        .mockResolvedValueOnce({
          _id: new MockObjectId('folder-a-project'),
          name: 'Paper A',
        })
        .mockResolvedValueOnce({
          _id: new MockObjectId('folder-b-project'),
          name: 'Paper B',
        })
      db.googleDriveProjectStates.insertOne.mockResolvedValue({
        insertedId: 'x',
      })
      db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
        value: { projectId: new MockObjectId(projectId) },
      })
      ProjectGetter.promises.getProject.mockResolvedValue({
        _id: new MockObjectId(projectId),
        name: 'Paper A',
        owner_ref: new MockObjectId(userId),
      })
      GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue('folder-a')
      ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
        docs: [],
        files: [],
      })
      DocstoreManager.promises.getAllDocs.mockResolvedValue([])

      const result =
        await GoogleDriveSyncManager.reconcileExistingDriveProjects(userId)

      expect(result.scannedCount).toBe(2)
      expect(result.createdCount).toBe(2)
      const rootScanCalls = GoogleDriveClient.listFiles.mock.calls.filter(
        call => call[1].includes(rootFolderId)
      )
      expect(rootScanCalls).toHaveLength(2)
      expect(rootScanCalls[1][3]).toBe('page-2')
    })
  })

  describe('duplicate project name collision handling', function () {
    const rootFolderId = 'gdrive-root-folder-id-111'
    const otherProjectId = '60d5ecb8b392d40015b6d5f9'

    describe('outbound folder name resolution (getOrCreateProjectFolder)', function () {
      it('reuses existing driveFolderId when already valid in Google Drive', async function () {
        db.googleDriveProjectStates.findOne.mockResolvedValue({
          projectId: new MockObjectId(projectId),
          userId: new MockObjectId(userId),
          driveFolderId: 'existing-valid-folder-id',
          folderName: 'My Project',
        })

        GoogleDriveClient.getFileMetadata.mockResolvedValue({
          id: 'existing-valid-folder-id',
          name: 'My Project',
          parents: [rootFolderId],
          trashed: false,
        })

        const folderId = await GoogleDriveSyncManager.getOrCreateProjectFolder(
          userId,
          rootFolderId,
          'My Project',
          projectId
        )

        expect(folderId).toBe('existing-valid-folder-id')
        expect(GoogleDriveClient.getFileMetadata).toHaveBeenCalledWith(
          userId,
          'existing-valid-folder-id',
          'id,name,parents,trashed'
        )
        expect(GoogleDriveClient.listFiles).not.toHaveBeenCalled()
      })

      it('reuses existing folder in Drive when name matches and is not bound to another project', async function () {
        db.googleDriveProjectStates.findOne
          .mockResolvedValueOnce(null) // no existing state for this project
          .mockResolvedValueOnce(null) // findOne for boundToOther -> not bound

        GoogleDriveClient.listFiles.mockResolvedValue({
          files: [
            {
              id: 'unbound-folder-id',
              name: 'My Project',
              mimeType: 'application/vnd.google-apps.folder',
              trashed: false,
            },
          ],
        })

        const folderId = await GoogleDriveSyncManager.getOrCreateProjectFolder(
          userId,
          rootFolderId,
          'My Project',
          projectId
        )

        expect(folderId).toBe('unbound-folder-id')
        expect(db.googleDriveProjectStates.findOne).toHaveBeenCalledWith({
          userId: expect.anything(),
          driveFolderId: 'unbound-folder-id',
          projectId: { $ne: expect.anything() },
        })
      })

      it('appends " 1" on collision when existing folder is bound to another project', async function () {
        db.googleDriveProjectStates.findOne
          .mockResolvedValueOnce(null) // no state for this project
          .mockResolvedValueOnce({
            projectId: new MockObjectId(otherProjectId),
            driveFolderId: 'bound-folder-id',
          }) // 'My Project' is bound to other project

        GoogleDriveClient.listFiles.mockResolvedValue({
          files: [
            {
              id: 'bound-folder-id',
              name: 'My Project',
              mimeType: 'application/vnd.google-apps.folder',
              trashed: false,
            },
          ],
        })

        GoogleDriveClient.getOrCreateSubfolder.mockResolvedValue(
          'folder-suffix-1-id'
        )

        const folderId = await GoogleDriveSyncManager.getOrCreateProjectFolder(
          userId,
          rootFolderId,
          'My Project',
          projectId
        )

        expect(folderId).toBe('folder-suffix-1-id')
        expect(GoogleDriveClient.getOrCreateSubfolder).toHaveBeenCalledWith(
          userId,
          rootFolderId,
          'My Project 1'
        )
        expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
          { projectId: expect.anything() },
          {
            $set: {
              driveFolderId: 'folder-suffix-1-id',
              folderName: 'My Project 1',
            },
          }
        )
      })

      it('appends " 2" on collision when " 1" is also bound to another project', async function () {
        db.googleDriveProjectStates.findOne
          .mockResolvedValueOnce(null) // no state for this project
          .mockResolvedValueOnce({
            projectId: new MockObjectId(otherProjectId),
            driveFolderId: 'bound-0',
          }) // 'My Project' bound
          .mockResolvedValueOnce({
            projectId: new MockObjectId(otherProjectId),
            driveFolderId: 'bound-1',
          }) // 'My Project 1' bound

        GoogleDriveClient.listFiles.mockResolvedValue({
          files: [
            {
              id: 'bound-0',
              name: 'My Project',
              mimeType: 'application/vnd.google-apps.folder',
              trashed: false,
            },
            {
              id: 'bound-1',
              name: 'My Project 1',
              mimeType: 'application/vnd.google-apps.folder',
              trashed: false,
            },
          ],
        })

        GoogleDriveClient.getOrCreateSubfolder.mockResolvedValue(
          'folder-suffix-2-id'
        )

        const folderId = await GoogleDriveSyncManager.getOrCreateProjectFolder(
          userId,
          rootFolderId,
          'My Project',
          projectId
        )

        expect(folderId).toBe('folder-suffix-2-id')
        expect(GoogleDriveClient.getOrCreateSubfolder).toHaveBeenCalledWith(
          userId,
          rootFolderId,
          'My Project 2'
        )
        expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
          { projectId: expect.anything() },
          {
            $set: {
              driveFolderId: 'folder-suffix-2-id',
              folderName: 'My Project 2',
            },
          }
        )
      })

      it('sets syncSuspended and suspendReason when max 100 folder collision attempts are reached', async function () {
        // Mock state: no state initially, and every suffix is bound to another project
        db.googleDriveProjectStates.findOne.mockImplementation(query => {
          if (query.projectId && !query.driveFolderId) {
            return Promise.resolve(null)
          }
          if (query.driveFolderId) {
            return Promise.resolve({
              projectId: new MockObjectId(otherProjectId),
              driveFolderId: query.driveFolderId,
            })
          }
          return Promise.resolve(null)
        })

        // All 1..100 folders exist in Drive
        const files = [
          {
            id: 'folder-base',
            name: 'My Project',
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
          },
        ]
        for (let i = 1; i <= 100; i++) {
          files.push({
            id: `folder-${i}`,
            name: `My Project ${i}`,
            mimeType: 'application/vnd.google-apps.folder',
            trashed: false,
          })
        }
        GoogleDriveClient.listFiles.mockResolvedValue({ files })

        let error
        try {
          await GoogleDriveSyncManager.getOrCreateProjectFolder(
            userId,
            rootFolderId,
            'My Project',
            projectId
          )
        } catch (err) {
          error = err
        }

        expect(error).toBeDefined()
        expect(error.message).toMatch(/Cannot resolve unique folder name/i)

        expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
          { projectId: expect.anything() },
          expect.objectContaining({
            $set: expect.objectContaining({
              syncSuspended: true,
              suspendReason: 'duplicate-folder-name',
            }),
          }),
          { upsert: true }
        )
      })
    })

    describe('inbound project creation collision (_createProjectFromDriveFolder)', function () {
      it('creates project with original folder name when no project name collision exists', async function () {
        ProjectGetter.promises.findUsersProjectsByName.mockResolvedValue([])
        ProjectCreationHandler.promises.createBlankProject.mockResolvedValue({
          _id: new MockObjectId(projectId),
          name: 'Remote Folder',
        })
        db.googleDriveProjectStates.insertOne.mockResolvedValue({
          insertedId: projectId,
        })
        db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
          value: { projectId: new MockObjectId(projectId) },
        })
        ProjectGetter.promises.getProject.mockResolvedValue({
          _id: new MockObjectId(projectId),
          name: 'Remote Folder',
          owner_ref: new MockObjectId(userId),
        })
        GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
        GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
          'remote-folder-id'
        )
        GoogleDriveClient.listFiles.mockResolvedValue({ files: [] })
        ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
          docs: [],
          files: [],
        })
        DocstoreManager.promises.getAllDocs.mockResolvedValue([])

        const driveFolder = { id: 'remote-folder-id', name: 'Remote Folder' }
        const state =
          await GoogleDriveSyncManager._createProjectFromDriveFolder(
            userId,
            driveFolder
          )

        expect(
          ProjectCreationHandler.promises.createBlankProject
        ).toHaveBeenCalledWith(userId, 'Remote Folder')
        expect(state.folderName).toBe('Remote Folder')
      })

      it('appends " (1)" when project name collides with existing active or trashed project', async function () {
        ProjectGetter.promises.findUsersProjectsByName
          .mockResolvedValueOnce([
            {
              _id: new MockObjectId(otherProjectId),
              name: 'Remote Folder',
              trashed: true,
            },
          ])
          .mockResolvedValueOnce([]) // 'Remote Folder (1)' has no collision

        ProjectCreationHandler.promises.createBlankProject.mockResolvedValue({
          _id: new MockObjectId(projectId),
          name: 'Remote Folder (1)',
        })
        db.googleDriveProjectStates.insertOne.mockResolvedValue({
          insertedId: projectId,
        })
        db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
          value: { projectId: new MockObjectId(projectId) },
        })
        ProjectGetter.promises.getProject.mockResolvedValue({
          _id: new MockObjectId(projectId),
          name: 'Remote Folder (1)',
          owner_ref: new MockObjectId(userId),
        })
        GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
        GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
          'remote-folder-id'
        )
        GoogleDriveClient.listFiles.mockResolvedValue({ files: [] })
        ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
          docs: [],
          files: [],
        })
        DocstoreManager.promises.getAllDocs.mockResolvedValue([])

        const driveFolder = { id: 'remote-folder-id', name: 'Remote Folder' }
        await GoogleDriveSyncManager._createProjectFromDriveFolder(
          userId,
          driveFolder
        )

        expect(
          ProjectGetter.promises.findUsersProjectsByName
        ).toHaveBeenCalledWith(userId, 'Remote Folder')
        expect(
          ProjectGetter.promises.findUsersProjectsByName
        ).toHaveBeenCalledWith(userId, 'Remote Folder (1)')
        expect(
          ProjectCreationHandler.promises.createBlankProject
        ).toHaveBeenCalledWith(userId, 'Remote Folder (1)')
      })

      it('appends " (2)" when both base name and " (1)" collide', async function () {
        ProjectGetter.promises.findUsersProjectsByName
          .mockResolvedValueOnce([
            { _id: new MockObjectId('proj-a'), name: 'Remote Folder' },
          ])
          .mockResolvedValueOnce([
            { _id: new MockObjectId('proj-b'), name: 'Remote Folder (1)' },
          ])
          .mockResolvedValueOnce([]) // 'Remote Folder (2)' free

        ProjectCreationHandler.promises.createBlankProject.mockResolvedValue({
          _id: new MockObjectId(projectId),
          name: 'Remote Folder (2)',
        })
        db.googleDriveProjectStates.insertOne.mockResolvedValue({
          insertedId: projectId,
        })
        db.googleDriveProjectStates.findOneAndUpdate.mockResolvedValue({
          value: { projectId: new MockObjectId(projectId) },
        })
        ProjectGetter.promises.getProject.mockResolvedValue({
          _id: new MockObjectId(projectId),
          name: 'Remote Folder (2)',
          owner_ref: new MockObjectId(userId),
        })
        GoogleDriveClient.getOrCreateRootFolder.mockResolvedValue(rootFolderId)
        GoogleDriveClient.getOrCreateProjectFolder.mockResolvedValue(
          'remote-folder-id'
        )
        GoogleDriveClient.listFiles.mockResolvedValue({ files: [] })
        ProjectEntityHandler.promises.getAllEntities.mockResolvedValue({
          docs: [],
          files: [],
        })
        DocstoreManager.promises.getAllDocs.mockResolvedValue([])

        const driveFolder = { id: 'remote-folder-id', name: 'Remote Folder' }
        await GoogleDriveSyncManager._createProjectFromDriveFolder(
          userId,
          driveFolder
        )

        expect(
          ProjectCreationHandler.promises.createBlankProject
        ).toHaveBeenCalledWith(userId, 'Remote Folder (2)')
      })

      it('sets syncSuspended and suspendReason when max 100 project collision attempts are reached', async function () {
        // Base name and all 1..100 suffixes collide
        ProjectGetter.promises.findUsersProjectsByName.mockResolvedValue([
          { _id: new MockObjectId('collision-id'), name: 'Colliding' },
        ])

        const driveFolder = { id: 'remote-folder-id', name: 'Colliding' }
        let error
        try {
          await GoogleDriveSyncManager._createProjectFromDriveFolder(
            userId,
            driveFolder
          )
        } catch (err) {
          error = err
        }

        expect(error).toBeDefined()
        expect(error.message).toMatch(/Cannot resolve unique project name/i)

        expect(db.googleDriveProjectStates.insertOne).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: expect.anything(),
            driveFolderId: 'remote-folder-id',
            syncSuspended: true,
            suspendReason: 'duplicate-project-name',
          })
        )
      })
    })
  })
})
