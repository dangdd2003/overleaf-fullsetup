import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import sinon from 'sinon'
import nock from 'nock'
import GitBridgeSnapshotManager from '../../../../../app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs'
import ProjectGetter from '../../../../../app/src/Features/Project/ProjectGetter.mjs'
import UserGetter from '../../../../../app/src/Features/User/UserGetter.mjs'
import DocstoreManager from '../../../../../app/src/Features/Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorController from '../../../../../app/src/Features/Editor/EditorController.mjs'
import Settings from '@overleaf/settings'
import { fetchNothing } from '@overleaf/fetch-utils'

describe('GitBridgeSnapshotManager', function () {
  const projectId = '60f1b4a9e1b2c3d4e5f6a7b8'
  const userId = '60f1b4a9e1b2c3d4e5f6a7b9'

  let origGetProjectWithoutLock
  let origPromisesGetProjectWithoutLock
  let origGetProject
  let origPromisesGetProject
  let origGetUser
  let origPromisesGetUser
  let origGetDoc
  let origDocstorePromisesGetDoc
  let origGetAllDocVersions
  let origDocstorePromisesGetAllDocVersions
  let origGetAllDocs
  let origDocstorePromisesGetAllDocs
  let origFlushProjectToMongo
  let origFetch
  let origFetchNothing
  let origUpsertDocWithPath
  let origUpsertFileWithPath
  let origDeleteEntityWithPath

  function setMockProject(fn) {
    ProjectGetter.getProjectWithoutLock = fn
    ProjectGetter.getProject = fn
    if (ProjectGetter.promises) {
      ProjectGetter.promises.getProjectWithoutLock = fn
      ProjectGetter.promises.getProject = fn
    }
  }

  function setMockUser(fn) {
    UserGetter.getUser = fn
    if (UserGetter.promises) {
      UserGetter.promises.getUser = fn
    }
  }

  let origSecurity

  beforeEach(function () {
    origSecurity = Settings.security
    Settings.security = { sessionSecret: 'test-secret-12345' }
    origGetProjectWithoutLock = ProjectGetter.getProjectWithoutLock
    origPromisesGetProjectWithoutLock =
      ProjectGetter.promises?.getProjectWithoutLock
    origGetProject = ProjectGetter.getProject
    origPromisesGetProject = ProjectGetter.promises?.getProject
    origGetUser = UserGetter.getUser
    origPromisesGetUser = UserGetter.promises?.getUser
    origGetDoc = DocstoreManager.getDoc
    origDocstorePromisesGetDoc = DocstoreManager.promises?.getDoc
    origGetAllDocVersions = DocstoreManager.getAllDocVersions
    origDocstorePromisesGetAllDocVersions =
      DocstoreManager.promises?.getAllDocVersions
    origGetAllDocs = DocstoreManager.getAllDocs
    origDocstorePromisesGetAllDocs =
      DocstoreManager.promises?.getAllDocs
    origFlushProjectToMongo =
      DocumentUpdaterHandler.promises?.flushProjectToMongo
    origFetch = globalThis.fetch
    origFetchNothing = fetchNothing.impl

    if (!EditorController.promises) {
      EditorController.promises = {}
    }
    origUpsertDocWithPath = EditorController.promises.upsertDocWithPath
    origUpsertFileWithPath = EditorController.promises.upsertFileWithPath
    origDeleteEntityWithPath = EditorController.promises.deleteEntityWithPath
  })

  afterEach(function () {
    sinon.restore()
    Settings.security = origSecurity
    ProjectGetter.getProjectWithoutLock = origGetProjectWithoutLock
    if (ProjectGetter.promises) {
      ProjectGetter.promises.getProjectWithoutLock =
        origPromisesGetProjectWithoutLock
      ProjectGetter.promises.getProject = origPromisesGetProject
    }
    ProjectGetter.getProject = origGetProject
    UserGetter.getUser = origGetUser
    if (UserGetter.promises) {
      UserGetter.promises.getUser = origPromisesGetUser
    }
    DocstoreManager.getDoc = origGetDoc
    if (DocstoreManager.promises) {
      DocstoreManager.promises.getDoc = origDocstorePromisesGetDoc
    }
    DocstoreManager.getAllDocVersions = origGetAllDocVersions
    if (DocstoreManager.promises) {
      DocstoreManager.promises.getAllDocVersions =
        origDocstorePromisesGetAllDocVersions
    }
    DocstoreManager.getAllDocs = origGetAllDocs
    if (DocstoreManager.promises) {
      DocstoreManager.promises.getAllDocs =
        origDocstorePromisesGetAllDocs
    }
    if (DocumentUpdaterHandler.promises) {
      DocumentUpdaterHandler.promises.flushProjectToMongo =
        origFlushProjectToMongo
    }
    globalThis.fetch = origFetch
    fetchNothing.impl = origFetchNothing
    if (EditorController.promises) {
      EditorController.promises.upsertDocWithPath = origUpsertDocWithPath
      EditorController.promises.upsertFileWithPath = origUpsertFileWithPath
      EditorController.promises.deleteEntityWithPath = origDeleteEntityWithPath
    }
  })

  describe('getDoc', function () {
    it('flushes document updater and returns doc metadata with version, timestamp, and author', async function () {
      let flushed = false
      DocumentUpdaterHandler.promises.flushProjectToMongo = async pId => {
        if (pId === projectId) flushed = true
      }

      setMockProject(async () => ({
        _id: projectId,
        version: 12,
        lastUpdatedAt: new Date('2026-08-24T10:00:00Z'),
        owner_ref: {
          email: 'author@example.com',
          first_name: 'Jane',
          last_name: 'Doe',
        },
      }))

      DocstoreManager.promises.getAllDocVersions = async () => [
        { _id: 'doc-1', version: 3 },
        { _id: 'doc-2', version: 2 },
      ]

      const meta = await GitBridgeSnapshotManager.getDoc(projectId)
      expect(flushed).toBe(true)
      // latestVerId = project.version (12) + docVersions (3 + 2) = 17
      expect(meta.latestVerId).toBe(17)
      expect(meta.latestVerAt).toBe('2026-08-24T10:00:00.000Z')
      expect(meta.latestVerBy.email).toBe('author@example.com')
      expect(meta.latestVerBy.name).toBe('Jane Doe')
    })

    it('increments latestVerId when doc versions change in docstore', async function () {
      setMockProject(async () => ({
        _id: projectId,
        version: 1,
        lastUpdatedAt: new Date('2026-08-24T10:00:00Z'),
      }))

      DocstoreManager.promises.getAllDocVersions = async () => [
        { _id: 'doc-1', version: 1 },
      ]

      const meta1 = await GitBridgeSnapshotManager.getDoc(projectId)
      expect(meta1.latestVerId).toBe(2)

      // User edits doc on website -> docstore doc version becomes 2
      DocstoreManager.promises.getAllDocVersions = async () => [
        { _id: 'doc-1', version: 2 },
      ]

      const meta2 = await GitBridgeSnapshotManager.getDoc(projectId)
      expect(meta2.latestVerId).toBe(3)
      expect(meta2.latestVerId).toBeGreaterThan(meta1.latestVerId)
    })

    it('fetches owner details via UserGetter if owner_ref is an ID', async function () {
      setMockProject(async () => ({
        _id: projectId,
        version: 5,
        lastUpdatedAt: new Date('2026-08-24T12:00:00Z'),
        owner_ref: '60f1b4a9e1b2c3d4e5f6a7b9',
      }))
      setMockUser(async () => ({
        _id: '60f1b4a9e1b2c3d4e5f6a7b9',
        email: 'owner@example.com',
        first_name: 'John',
        last_name: 'Smith',
      }))
      DocstoreManager.promises.getAllDocVersions = async () => []

      const meta = await GitBridgeSnapshotManager.getDoc(projectId)
      expect(meta.latestVerId).toBe(5)
      expect(meta.latestVerBy.email).toBe('owner@example.com')
      expect(meta.latestVerBy.name).toBe('John Smith')
    })

    it('returns default author if owner_ref is missing', async function () {
      setMockProject(async () => ({
        _id: projectId,
        version: 1,
      }))
      DocstoreManager.promises.getAllDocVersions = async () => []

      const meta = await GitBridgeSnapshotManager.getDoc(projectId)
      expect(meta.latestVerId).toBe(1)
      expect(meta.latestVerBy.email).toBe('git@overleaf.com')
      expect(meta.latestVerBy.name).toBe('Overleaf User')
    })

    it('returns null if project does not exist', async function () {
      setMockProject(async () => null)
      const meta = await GitBridgeSnapshotManager.getDoc(projectId)
      expect(meta).toBeNull()
    })
  })

  describe('getSavedVers', function () {
    it('returns list of saved versions', async function () {
      setMockProject(async () => ({
        _id: projectId,
        version: 12,
        lastUpdatedAt: new Date('2026-08-24T10:00:00Z'),
        owner_ref: {
          email: 'author@example.com',
          first_name: 'Jane',
          last_name: 'Doe',
        },
      }))
      DocstoreManager.promises.getAllDocVersions = async () => [
        { _id: 'doc-1', version: 1 },
      ]

      const savedVers = await GitBridgeSnapshotManager.getSavedVers(projectId)
      expect(Array.isArray(savedVers)).toBe(true)
      expect(savedVers.length).toBe(1)
      expect(savedVers[0].versionId).toBe(13)
      expect(savedVers[0].comment).toBe('Current version')
      expect(savedVers[0].user.email).toBe('author@example.com')
      expect(savedVers[0].createdAt).toBe('2026-08-24T10:00:00.000Z')
    })

    it('returns empty array if project does not exist', async function () {
      setMockProject(async () => null)
      const savedVers = await GitBridgeSnapshotManager.getSavedVers(projectId)
      expect(savedVers).toEqual([])
    })
  })

  describe('getSnapshotForVersion', function () {
    it('flushes document-updater, traverses project tree and returns srcs and atts', async function () {
      let flushed = false
      DocumentUpdaterHandler.promises.flushProjectToMongo = async pId => {
        if (pId === projectId) flushed = true
      }

      const mockProject = {
        _id: projectId,
        version: 12,
        rootFolder: [
          {
            _id: 'root-id',
            name: 'rootFolder',
            docs: [{ _id: 'doc-1', name: 'main.tex' }],
            fileRefs: [{ _id: 'file-1', name: 'figure.png' }],
            folders: [
              {
                _id: 'subfolder-id',
                name: 'chapters',
                docs: [{ _id: 'doc-2', name: 'intro.tex' }],
                fileRefs: [],
                folders: [],
              },
            ],
          },
        ],
      }
      setMockProject(async () => mockProject)

      DocstoreManager.getDoc = async (projId, docId) => {
        if (docId === 'doc-1') {
          return ['\\documentclass{article}', '\\begin{document}']
        }
        if (docId === 'doc-2') return ['\\section{Intro}']
        return []
      }
      if (DocstoreManager.promises) {
        DocstoreManager.promises.getDoc = DocstoreManager.getDoc
      }

      const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(
        projectId,
        12
      )
      expect(flushed).toBe(true)
      expect(snapshot.srcs).toEqual([
        ['\\documentclass{article}\n\\begin{document}', 'main.tex'],
        ['\\section{Intro}', 'chapters/intro.tex'],
      ])
      expect(Array.isArray(snapshot.atts)).toBe(true)
      expect(snapshot.atts.length).toBe(1)
      expect(snapshot.atts[0][1]).toContain('figure.png')
      expect(snapshot.atts[0][0]).toContain(`/api/v0/docs/${projectId}/file/file-1`)
      expect(snapshot.atts[0][0]).toContain('token=')
    })

    it('returns null if project is not found', async function () {
      setMockProject(async () => null)
      const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(
        projectId,
        12
      )
      expect(snapshot).toBeNull()
    })

    it('returns project snapshot when versionId is provided', async function () {
      const mockProject = {
        _id: projectId,
        version: 12,
        rootFolder: [
          {
            _id: 'root-id',
            name: 'rootFolder',
            docs: [],
            fileRefs: [],
            folders: [],
          },
        ],
      }
      setMockProject(async () => mockProject)
      DocstoreManager.promises.getAllDocVersions = async () => []

      const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(
        projectId,
        5
      )
      expect(snapshot).toEqual({ srcs: [], atts: [] })
    })
  })

  describe('getSnapshotForVersion batch doc map', function () {
    it('uses batch docs keyed by _id string', async function () {
      const batchProjectId = 'batch-test-project'
      setMockProject(async () => ({
        _id: batchProjectId,
        version: 1,
        rootFolder: [
          {
            _id: 'root',
            name: 'rootFolder',
            docs: [
              { _id: 'doc-a', name: 'main.tex' },
              { _id: 'doc-b', name: 'other.tex' },
            ],
            fileRefs: [],
            folders: [],
          },
        ],
      }))

      DocstoreManager.promises.getAllDocVersions = async () => [
        { _id: 'doc-a', version: 1 },
        { _id: 'doc-b', version: 1 },
      ]

      let getAllDocsCalled = false
      let getDocCallCount = 0
      DocstoreManager.promises.getAllDocs = async () => {
        getAllDocsCalled = true
        return [
          { _id: 'doc-a', lines: ['line 1', 'line 2'] },
          { _id: 'doc-b', lines: ['hello'] },
        ]
      }
      DocstoreManager.promises.getDoc = async () => {
        getDocCallCount++
        return { lines: ['fallback'] }
      }

      const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(
        batchProjectId,
        undefined
      )

      expect(getAllDocsCalled).toBe(true)
      // Should NOT fall back to individual getDoc calls when batch succeeds
      expect(getDocCallCount).toBe(0)
      // Verify snapshot.srcs contains the two batch-fetched docs
      const mainDoc = snapshot.srcs.find(s => s[1] === 'main.tex')
      const otherDoc = snapshot.srcs.find(s => s[1] === 'other.tex')
      expect(mainDoc).toBeDefined()
      expect(mainDoc[0]).toEqual('line 1\nline 2')
      expect(otherDoc).toBeDefined()
      expect(otherDoc[0]).toEqual('hello')
    })
  })

  describe('getSnapshotForVersion callback fallback', function () {
    it('uses callback-style getDoc when promises API unavailable', async function () {
      const projectId = 'callback-fallback-project'
      setMockProject(async () => ({
        _id: projectId,
        version: 1,
        rootFolder: [
          {
            _id: 'root',
            name: 'rootFolder',
            docs: [{ _id: 'doc-c', name: 'main.tex' }],
            fileRefs: [],
            folders: [],
          },
        ],
      }))

      DocstoreManager.promises.getAllDocVersions = async () => []
      DocstoreManager.promises.getAllDocs = undefined
      DocstoreManager.promises.getDoc = undefined
      // Return array directly like the existing test pattern
      DocstoreManager.getDoc = (projectId, docId, callback) => {
        callback(null, ['callback content'])
      }

      const snapshot = await GitBridgeSnapshotManager.getSnapshotForVersion(
        projectId,
        undefined
      )

      const mainDoc = snapshot.srcs.find(s => s[1] === 'main.tex')
      expect(mainDoc).toBeTruthy()
      // Content is joined array: 'callback content'
      expect(mainDoc[0]).toEqual('callback content')
    })
  })

  describe('validatePushVersion', function () {
    it('validates matching version', async function () {
      setMockProject(async () => ({
        _id: projectId,
        version: 10,
      }))
      DocstoreManager.promises.getAllDocVersions = async () => [
        { _id: 'doc-1', version: 2 },
      ]

      const result = await GitBridgeSnapshotManager.validatePushVersion(
        projectId,
        12
      )
      expect(result.valid).toBe(true)
    })

    it('rejects mismatching version with outOfDate', async function () {
      setMockProject(async () => ({
        _id: projectId,
        version: 10,
      }))
      DocstoreManager.promises.getAllDocVersions = async () => [
        { _id: 'doc-1', version: 5 },
      ]

      const result = await GitBridgeSnapshotManager.validatePushVersion(
        projectId,
        12
      )
      expect(result.valid).toBe(false)
      expect(result.code).toBe('outOfDate')
    })

    it('rejects nonexistent project with invalidProject', async function () {
      setMockProject(async () => null)
      const result = await GitBridgeSnapshotManager.validatePushVersion(
        projectId,
        12
      )
      expect(result.valid).toBe(false)
      expect(result.code).toBe('invalidProject')
    })
  })

  describe('processPush', function () {
    it('processes doc updates, file updates, and deletions and sends postback with updated latestVerId', async function () {
      const files = [
        { name: 'main.tex', url: 'http://git-bridge/raw/main.tex' },
        { name: 'image.png', url: 'http://git-bridge/raw/image.png' },
      ]
      const postbackUrl = 'http://git-bridge/postback/test-key'

      let upsertDocCalled = false
      let upsertFileCalled = false
      let deleteEntityCalled = false
      let postbackPayload = null

      nock('http://git-bridge')
        .post('/postback/test-key')
        .reply(200, (uri, requestBody) => {
          postbackPayload = requestBody
          return {}
        })

      fetchNothing.impl = async (url, opts) => {
        postbackPayload = opts?.json
      }

      globalThis.fetch = async url => {
        if (url === 'http://git-bridge/raw/main.tex') {
          return {
            ok: true,
            arrayBuffer: async () =>
              Buffer.from('\\documentclass{article}\n\\begin{document}Hello\\end{document}'),
          }
        }
        if (url === 'http://git-bridge/raw/image.png') {
          return {
            ok: true,
            arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          }
        }
        throw new Error(`Unexpected fetch URL: ${url}`)
      }

      EditorController.promises.upsertDocWithPath = async (
        pId,
        filePath,
        lines,
        source,
        uId
      ) => {
        upsertDocCalled = true
        expect(pId).toBe(projectId)
        expect(filePath).toBe('/main.tex')
        expect(lines).toEqual(['\\documentclass{article}', '\\begin{document}Hello\\end{document}'])
        expect(source).toBe('git-bridge')
        expect(uId).toBe(userId)
      }

      EditorController.promises.upsertFileWithPath = async (
        pId,
        filePath,
        localPath,
        folderId,
        source,
        uId
      ) => {
        upsertFileCalled = true
        expect(pId).toBe(projectId)
        expect(filePath).toBe('/image.png')
        expect(source).toBe('git-bridge')
        expect(uId).toBe(userId)
      }

      EditorController.promises.deleteEntityWithPath = async (
        pId,
        filePath,
        source,
        uId
      ) => {
        deleteEntityCalled = true
        expect(pId).toBe(projectId)
        expect(filePath).toBe('/deleted.tex')
        expect(source).toBe('git-bridge')
        expect(uId).toBe(userId)
      }

      setMockProject(async () => ({
        _id: projectId,
        version: 5,
        rootFolder: [
          {
            _id: 'root-id',
            name: 'rootFolder',
            docs: [{ _id: 'doc-del', name: 'deleted.tex' }],
            fileRefs: [],
            folders: [],
          },
        ],
      }))
      DocstoreManager.promises.getAllDocVersions = async () => [
        { _id: 'doc-1', version: 3 },
      ]

      await GitBridgeSnapshotManager.processPush(
        projectId,
        userId,
        files,
        postbackUrl
      )

      expect(upsertDocCalled).toBe(true)
      expect(upsertFileCalled).toBe(true)
      expect(deleteEntityCalled).toBe(true)
      expect(postbackPayload).toEqual({
        code: 'upToDate',
        latestVerId: 8, // 5 + 3
      })
    })

    it('downloads all files before deleting removed entities', async function () {
      const callOrder = []
      setMockProject(async () => ({
        _id: projectId,
        version: 5,
        rootFolder: [
          {
            _id: 'root-id',
            name: 'rootFolder',
            docs: [{ _id: 'doc-del', name: 'old-file.tex' }],
            fileRefs: [],
            folders: [],
          },
        ],
      }))
      DocstoreManager.promises.getAllDocVersions = async () => []

      EditorController.promises.deleteEntityWithPath = async () => {
        callOrder.push('delete')
      }
      EditorController.promises.upsertDocWithPath = async () => {
        callOrder.push('upsert')
      }

      globalThis.fetch = async () => {
        callOrder.push('fetch')
        return {
          ok: true,
          arrayBuffer: async () => Buffer.from('hello'),
        }
      }

      const files = [
        { name: 'new-file.tex', url: 'http://git-bridge/raw/new-file.tex' },
      ]

      await GitBridgeSnapshotManager.processPush(
        projectId,
        userId,
        files,
        null
      )

      const firstDeleteIdx = callOrder.indexOf('delete')
      const lastFetchIdx = callOrder.lastIndexOf('fetch')
      expect(lastFetchIdx).toBeLessThan(firstDeleteIdx)
    })

    it('includes folders in deletion comparison', async function () {
      const deletedPaths = []
      setMockProject(async () => ({
        _id: projectId,
        version: 1,
        rootFolder: [
          {
            _id: 'root-id',
            name: 'rootFolder',
            docs: [],
            fileRefs: [],
            folders: [
              { _id: 'f1', name: 'images', docs: [], fileRefs: [], folders: [] },
            ],
          },
        ],
      }))
      DocstoreManager.promises.getAllDocVersions = async () => []

      EditorController.promises.deleteEntityWithPath = async (
        pId,
        path
      ) => {
        deletedPaths.push(path)
      }

      await GitBridgeSnapshotManager.processPush(projectId, userId, [], null)
      expect(deletedPaths).toContain('/images')
    })
  })
})
