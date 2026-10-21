import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import sinon from 'sinon'
import Settings from '@overleaf/settings'
import AuthorizationManager from '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import GitBridgeApiController from '../../../app/src/GitBridgeApiController.mjs'
import GitBridgeSnapshotManager from '../../../app/src/GitBridgeSnapshotManager.mjs'
import GitBridgeFileTokenManager from '../../../app/src/GitBridgeFileTokenManager.mjs'
import PersonalAccessTokenManager from '../../../../../app/src/Features/PersonalAccessToken/PersonalAccessTokenManager.mjs'
import HistoryManager from '../../../../../app/src/Features/History/HistoryManager.mjs'
import Errors from '../../../../../app/src/Features/Errors/Errors.js'
import { Writable } from 'node:stream'
import { Readable } from 'node:stream'

describe('GitBridgeApiController', function () {
  let req, res, statusCalls, jsonCalls
  const projectId = '60f1b4a9e1b2c3d4e5f6g7h8'

  let origGetDoc
  let origGetSavedVers
  let origGetSnapshotForVersion
  let origValidatePushVersion
  let origProcessPush

  beforeEach(function () {
    statusCalls = []
    jsonCalls = []

    req = {
      params: { projectId },
      body: {},
      session: { user: { _id: 'user-123' } },
    }
    res = {
      status(code) {
        statusCalls.push(code)
        return this
      },
      json(data) {
        jsonCalls.push(data)
        return this
      },
    }

    origGetDoc = GitBridgeSnapshotManager.getDoc
    origGetSavedVers = GitBridgeSnapshotManager.getSavedVers
    origGetSnapshotForVersion = GitBridgeSnapshotManager.getSnapshotForVersion
    origValidatePushVersion = GitBridgeSnapshotManager.validatePushVersion
    origProcessPush = GitBridgeSnapshotManager.processPush
  })

  afterEach(function () {
    sinon.restore()
    GitBridgeSnapshotManager.getDoc = origGetDoc
    GitBridgeSnapshotManager.getSavedVers = origGetSavedVers
    GitBridgeSnapshotManager.getSnapshotForVersion = origGetSnapshotForVersion
    GitBridgeSnapshotManager.validatePushVersion = origValidatePushVersion
    GitBridgeSnapshotManager.processPush = origProcessPush
  })

  describe('requireGitBridgeAuth', function () {
    let next
    beforeEach(function () {
      next = sinon.spy()
      req = {
        headers: {},
        params: { projectId },
        body: {},
      }
    })

    it('rejects with 401 when no auth credentials present', async function () {
      await GitBridgeApiController.requireGitBridgeAuth(req, res, next)
      expect(statusCalls[0]).toBe(401)
      expect(jsonCalls[0]).toEqual({
        code: 'unauthorized',
        message: 'Valid authentication required',
      })
      expect(next.called).toBe(false)
    })

    it('calls next() when session user present', async function () {
      req.session = { user: { _id: 'user-123' } }
      await GitBridgeApiController.requireGitBridgeAuth(req, res, next)
      expect(next.calledOnce).toBe(true)
      expect(req.gitBridgeUserId).toBe('user-123')
    })

    it('rejects a PAT that lacks the git_bridge scope with 403 insufficient_scope', async function () {
      req.headers.authorization = 'Bearer olp_mcponly'
      sinon
        .stub(PersonalAccessTokenManager, 'validateToken')
        .resolves({ userId: 'user-9', scopes: ['mcp'] })
      await GitBridgeApiController.requireGitBridgeAuth(req, res, next)
      expect(statusCalls[0]).toBe(403)
      expect(jsonCalls[0].code).toBe('insufficient_scope')
      expect(next.called).toBe(false)
    })

    it('accepts a PAT that carries the git_bridge scope', async function () {
      req.headers.authorization = 'Bearer olp_gitbridge'
      sinon
        .stub(PersonalAccessTokenManager, 'validateToken')
        .resolves({ userId: 'user-9', scopes: ['git_bridge'] })
      await GitBridgeApiController.requireGitBridgeAuth(req, res, next)
      expect(next.calledOnce).toBe(true)
      expect(req.gitBridgeUserId).toBe('user-9')
    })
  })

  describe('extractToken (via requireGitBridgeAuth)', function () {
    let next
    beforeEach(function () {
      next = sinon.spy()
      req = { headers: {}, params: { projectId }, body: {} }
    })

    it('rejects Basic auth with empty password (user=git, pass=empty)', async function () {
      // Authorization: Basic base64("git:")
      const encoded = Buffer.from('git:').toString('base64')
      req.headers.authorization = `Basic ${encoded}`
      await GitBridgeApiController.requireGitBridgeAuth(req, res, next)
      expect(statusCalls[0]).toBe(401)
      expect(next.called).toBe(false)
    })

    it('extracts query token and redacts it when empty Basic header is present (Authorization: Basic Z2l0Og==)', async function () {
      req.headers.authorization = 'Basic Z2l0Og=='
      req.query = { access_token: 'olp_secret_access_token_123' }
      req.url = '/api/v0/docs/123?access_token=olp_secret_access_token_123'
      req.originalUrl = '/api/v0/docs/123?access_token=olp_secret_access_token_123'

      sinon
        .stub(PersonalAccessTokenManager, 'validateToken')
        .resolves({ userId: 'user-token-owner', scopes: ['git_bridge'] })

      await GitBridgeApiController.requireGitBridgeAuth(req, res, next)

      expect(next.calledOnce).toBe(true)
      expect(req.gitBridgeUserId).toBe('user-token-owner')
      expect(
        PersonalAccessTokenManager.validateToken.calledWith(
          'olp_secret_access_token_123'
        )
      ).toBe(true)
      expect(req.query.access_token).toBe('olp_...')
      expect(req.url).toBe('/api/v0/docs/123?access_token=[REDACTED]')
      expect(req.originalUrl).toBe('/api/v0/docs/123?access_token=[REDACTED]')
    })

    it('ensures query token redaction is not bypassed when an empty Basic auth header is present and token is invalid', async function () {
      req.headers.authorization = 'Basic Z2l0Og=='
      req.query = { access_token: 'olp_invalid_token_xyz' }
      req.url = '/api/v0/docs/123?access_token=olp_invalid_token_xyz'
      req.originalUrl = '/api/v0/docs/123?access_token=olp_invalid_token_xyz'

      sinon
        .stub(PersonalAccessTokenManager, 'validateToken')
        .resolves(null)

      await GitBridgeApiController.requireGitBridgeAuth(req, res, next)

      expect(statusCalls[0]).toBe(401)
      expect(next.called).toBe(false)
      expect(req.query.access_token).toBe('olp_...')
      expect(req.url).toBe('/api/v0/docs/123?access_token=[REDACTED]')
      expect(req.originalUrl).toBe('/api/v0/docs/123?access_token=[REDACTED]')
    })

    it('extracts query token and redacts it via extractToken directly with empty Basic auth header', function () {
      req.headers.authorization = 'Basic Z2l0Og=='
      req.query = { access_token: 'olp_direct_token' }
      req.url = '/api/v0/docs/123?access_token=olp_direct_token'
      req.originalUrl = '/api/v0/docs/123?access_token=olp_direct_token'

      const extracted = GitBridgeApiController.extractToken(req)
      expect(extracted).toBe('olp_direct_token')
      expect(req.query.access_token).toBe('olp_...')
      expect(req.url).toBe('/api/v0/docs/123?access_token=[REDACTED]')
      expect(req.originalUrl).toBe('/api/v0/docs/123?access_token=[REDACTED]')
    })
  })

  describe('requireProjectRead', function () {
    let next
    beforeEach(function () {
      next = sinon.spy()
      req = {
        headers: {},
        params: { projectId },
        body: {},
      }
    })

    it('rejects with 401 when no auth credentials present', async function () {
      await GitBridgeApiController.requireProjectRead(req, res, next)
      expect(statusCalls[0]).toBe(401)
      expect(next.called).toBe(false)
    })
  })

  describe('requireFileAccess', function () {
    let next
    const fileId = 'file-abc-123'

    beforeEach(function () {
      next = sinon.spy()
      req = {
        headers: {},
        params: { projectId, fileId },
        query: {},
        body: {},
      }
      Settings.security = { sessionSecret: 'test-secret-12345' }
    })

    it('calls next() when a valid token is provided in query', async function () {
      const token = GitBridgeFileTokenManager.createFileToken(projectId, fileId)
      req.query.token = token
      await GitBridgeApiController.requireFileAccess(req, res, next)
      expect(next.calledOnce).toBe(true)
    })

    it('redacts the token from the query and URL that get logged, and still accepts it', async function () {
      const token = GitBridgeFileTokenManager.createFileToken(projectId, fileId)
      const url = `/api/v0/docs/${projectId}/file/${fileId}?token=${encodeURIComponent(token)}`
      req.url = url
      req.originalUrl = url
      req.query.token = token

      await GitBridgeApiController.requireFileAccess(req, res, next)

      expect(next.calledOnce).toBe(true)
      expect(req.query.token).toBe('[REDACTED]')
      expect(req.url).toBe(
        `/api/v0/docs/${projectId}/file/${fileId}?token=[REDACTED]`
      )
      expect(req.originalUrl).toBe(req.url)
      expect(req.url).not.toContain(token.split('.')[1])
    })

    it('redacts an invalid token from the logged URL too', async function () {
      const url = `/api/v0/docs/${projectId}/file/${fileId}?token=invalid.secret&access_token=keep`
      req.url = url
      req.originalUrl = url
      req.query.token = 'invalid.secret'

      await GitBridgeApiController.requireFileAccess(req, res, next)

      expect(req.url).not.toContain('invalid.secret')
      expect(req.originalUrl).not.toContain('invalid.secret')
      expect(req.query.token).toBe('[REDACTED]')
    })

    it('falls back to auth check when token is invalid or missing', async function () {
      req.query.token = 'invalid.token'

      await GitBridgeApiController.requireFileAccess(req, res, next)
      expect(statusCalls[0]).toBe(401)
      expect(next.called).toBe(false)
    })

    it('allows access via session when no token is present and user can read', async function () {
      req.session = { user: { _id: 'user-123' } }
      const origCanRead = AuthorizationManager.promises.canUserReadProject
      AuthorizationManager.promises.canUserReadProject = async () => true
      try {
        await GitBridgeApiController.requireFileAccess(req, res, next)
        expect(next.calledOnce).toBe(true)
      } finally {
        AuthorizationManager.promises.canUserReadProject = origCanRead
      }
    })

    it('returns 403 when session user cannot read project', async function () {
      req.session = { user: { _id: 'user-123' } }
      const origCanRead = AuthorizationManager.promises.canUserReadProject
      AuthorizationManager.promises.canUserReadProject = async () => false
      try {
        await GitBridgeApiController.requireFileAccess(req, res, next)
        expect(statusCalls[0]).toBe(403)
        expect(next.called).toBe(false)
      } finally {
        AuthorizationManager.promises.canUserReadProject = origCanRead
      }
    })

    it('returns 500 when auth check throws', async function () {
      req.session = { user: { _id: 'user-123' } }
      const origCanRead = AuthorizationManager.promises.canUserReadProject
      AuthorizationManager.promises.canUserReadProject = async () => {
        throw new Error('Database connection failure')
      }
      try {
        await GitBridgeApiController.requireFileAccess(req, res, next)
        expect(statusCalls[0]).toBe(500)
        expect(next.called).toBe(false)
      } finally {
        AuthorizationManager.promises.canUserReadProject = origCanRead
      }
    })
  })

  describe('adaptFileParams', function () {
    it('maps projectId and fileId to Project_id and File_id', function () {
      const next = sinon.spy()
      req.params = { projectId: 'p-1', fileId: 'f-1' }

      GitBridgeApiController.adaptFileParams(req, res, next)

      expect(req.params.Project_id).toBe('p-1')
      expect(req.params.File_id).toBe('f-1')
      expect(next.calledOnce).toBe(true)
    })
  })

  describe('getDoc', function () {
    it('handles getDoc successfully', async function () {
      GitBridgeSnapshotManager.getDoc = async () => ({
        latestVerId: 10,
        latestVerAt: '2026-08-24T10:00:00.000Z',
        latestVerBy: { email: 'author@example.com', name: 'Author' },
      })

      await GitBridgeApiController.getDoc(req, res)
      expect(jsonCalls.length).toBe(1)
      expect(jsonCalls[0]).toEqual({
        latestVerId: 10,
        latestVerAt: '2026-08-24T10:00:00.000Z',
        latestVerBy: { email: 'author@example.com', name: 'Author' },
      })
    })

    it('returns 404 in getDoc if project does not exist', async function () {
      GitBridgeSnapshotManager.getDoc = async () => null
      await GitBridgeApiController.getDoc(req, res)
      expect(statusCalls.length).toBe(1)
      expect(statusCalls[0]).toBe(404)
      expect(jsonCalls[0]).toEqual({
        code: 'invalidProject',
        message: 'Project not found',
      })
    })

    it('returns 500 in getDoc if manager throws an error', async function () {
      GitBridgeSnapshotManager.getDoc = async () => {
        throw new Error('DB error')
      }
      await GitBridgeApiController.getDoc(req, res)
      expect(statusCalls.length).toBe(1)
      expect(statusCalls[0]).toBe(500)
      expect(jsonCalls[0].code).toBe('error')
      expect(jsonCalls[0].message).toBe('internal error')
      expect(jsonCalls[0].errorId).toBeDefined()
    })
  })

  describe('getSavedVers', function () {
    it('returns saved versions list', async function () {
      GitBridgeSnapshotManager.getSavedVers = async () => [
        {
          versionId: 10,
          comment: 'Current version',
          user: { email: 'author@example.com', name: 'Author' },
          createdAt: '2026-08-24T10:00:00.000Z',
        },
      ]

      await GitBridgeApiController.getSavedVers(req, res)
      expect(jsonCalls.length).toBe(1)
      expect(jsonCalls[0]).toEqual([
        {
          versionId: 10,
          comment: 'Current version',
          user: { email: 'author@example.com', name: 'Author' },
          createdAt: '2026-08-24T10:00:00.000Z',
        },
      ])
    })

    it('returns 500 in getSavedVers on error', async function () {
      GitBridgeSnapshotManager.getSavedVers = async () => {
        throw new Error('fail')
      }
      await GitBridgeApiController.getSavedVers(req, res)
      expect(statusCalls.length).toBe(1)
      expect(statusCalls[0]).toBe(500)
      expect(jsonCalls[0].code).toBe('error')
      expect(jsonCalls[0].message).toBe('internal error')
      expect(jsonCalls[0].errorId).toBeDefined()
    })
  })

  describe('getSnapshot', function () {
    beforeEach(function () {
      // git-bridge calls the API at its own address, so that is the origin
      // the snapshot's file links must use.
      req.protocol = 'http'
      req.headers = { host: 'overleaf:3000' }
    })

    it('returns snapshot for version', async function () {
      req.params.versionId = '10'
      GitBridgeSnapshotManager.getSnapshotForVersion = async () => ({
        srcs: [['\\documentclass{article}', 'main.tex']],
        atts: [['http://example.com/file/1', 'fig.png']],
      })

      await GitBridgeApiController.getSnapshot(req, res)
      expect(jsonCalls.length).toBe(1)
      expect(jsonCalls[0]).toEqual({
        srcs: [['\\documentclass{article}', 'main.tex']],
        atts: [['http://example.com/file/1', 'fig.png']],
      })
    })

    it('builds file links on the origin git-bridge called', async function () {
      req.params.versionId = '10'
      let baseUrl
      GitBridgeSnapshotManager.getSnapshotForVersion = async (
        pId,
        verId,
        origin
      ) => {
        baseUrl = origin
        return { srcs: [], atts: [] }
      }

      await GitBridgeApiController.getSnapshot(req, res)
      expect(baseUrl).toBe('http://overleaf:3000')
    })

    it('keeps the scheme of the request and drops anything past the host', async function () {
      req.params.versionId = '10'
      req.protocol = 'https'
      req.headers.host = 'Overleaf.example.com:8443'
      let baseUrl
      GitBridgeSnapshotManager.getSnapshotForVersion = async (
        pId,
        verId,
        origin
      ) => {
        baseUrl = origin
        return { srcs: [], atts: [] }
      }

      await GitBridgeApiController.getSnapshot(req, res)
      expect(baseUrl).toBe('https://overleaf.example.com:8443')
    })

    it('refuses a Host that is not a bare host and port', async function () {
      req.params.versionId = '10'
      let called = false
      GitBridgeSnapshotManager.getSnapshotForVersion = async () => {
        called = true
        return { srcs: [], atts: [] }
      }

      for (const host of ['evil.example/x', 'user@evil.example', 'a.example:99999999', '']) {
        req.headers.host = host
        await GitBridgeApiController.getSnapshot(req, res)
      }
      expect(called).toBe(false)
      expect(statusCalls).toEqual([400, 400, 400, 400])
      expect(jsonCalls[0].code).toBe('invalidHost')
    })

    it('returns 404 if snapshot not found', async function () {
      req.params.versionId = '10'
      GitBridgeSnapshotManager.getSnapshotForVersion = async () => null

      await GitBridgeApiController.getSnapshot(req, res)
      expect(statusCalls.length).toBe(1)
      expect(statusCalls[0]).toBe(404)
      expect(jsonCalls[0]).toEqual({
        code: 'invalidProject',
        message: 'Snapshot not found',
      })
    })

    it('returns 500 on error', async function () {
      req.params.versionId = '10'
      GitBridgeSnapshotManager.getSnapshotForVersion = async () => {
        throw new Error('snapshot err')
      }

      await GitBridgeApiController.getSnapshot(req, res)
      expect(statusCalls.length).toBe(1)
      expect(statusCalls[0]).toBe(500)
      expect(jsonCalls[0].code).toBe('error')
      expect(jsonCalls[0].message).toBe('internal error')
      expect(jsonCalls[0].errorId).toBeDefined()
    })
  })

  describe('pushSnapshot', function () {
    it('handles pushSnapshot accepting valid version', async function () {
      req.body = {
        latestVerId: 10,
        files: [{ name: 'main.tex', url: 'http://git-bridge:8000/raw' }],
        postbackUrl: 'http://git-bridge:8000/postback',
      }
      let processPushCalled = false
      GitBridgeSnapshotManager.validatePushVersion = async () => ({
        valid: true,
      })
      GitBridgeSnapshotManager.processPush = async () => {
        processPushCalled = true
      }

      await GitBridgeApiController.pushSnapshot(req, res)
      expect(statusCalls.length).toBe(1)
      expect(statusCalls[0]).toBe(202)
      expect(jsonCalls[0]).toEqual({
        status: 202,
        code: 'accepted',
        message: 'Accepted',
      })
    })

    it('refuses a push with a file URL outside git-bridge before accepting it', async function () {
      req.body = {
        latestVerId: 10,
        files: [
          {
            name: 'stolen.tex',
            url: 'http://169.254.169.254/latest/meta-data/?key=secret',
          },
        ],
        postbackUrl: 'http://git-bridge:8000/postback',
      }
      let processPushCalled = false
      GitBridgeSnapshotManager.validatePushVersion = async () => ({
        valid: true,
      })
      GitBridgeSnapshotManager.processPush = async () => {
        processPushCalled = true
      }

      await GitBridgeApiController.pushSnapshot(req, res)
      expect(statusCalls).toEqual([400])
      expect(jsonCalls[0].code).toBe('invalidFiles')
      expect(jsonCalls[0].message).not.toContain('169.254.169.254')
      expect(processPushCalled).toBe(false)
    })

    it('refuses a push without a files array, so no entity is deleted by mistake', async function () {
      req.body = { latestVerId: 10, postbackUrl: 'http://git-bridge:8000/postback' }
      let processPushCalled = false
      GitBridgeSnapshotManager.validatePushVersion = async () => ({
        valid: true,
      })
      GitBridgeSnapshotManager.processPush = async () => {
        processPushCalled = true
      }

      await GitBridgeApiController.pushSnapshot(req, res)
      expect(statusCalls).toEqual([400])
      expect(jsonCalls[0].code).toBe('invalidFiles')
      expect(processPushCalled).toBe(false)
    })

    it('refuses a file entry with no name', async function () {
      req.body = {
        latestVerId: 10,
        files: [{ url: 'http://git-bridge:8000/raw' }],
        postbackUrl: 'http://git-bridge:8000/postback',
      }
      GitBridgeSnapshotManager.validatePushVersion = async () => ({
        valid: true,
      })

      await GitBridgeApiController.pushSnapshot(req, res)
      expect(statusCalls).toEqual([400])
    })

    it('returns 409 in pushSnapshot if out of date', async function () {
      req.body = {
        latestVerId: 8,
        files: [],
        postbackUrl: 'http://git-bridge:8000/postback',
      }
      GitBridgeSnapshotManager.validatePushVersion = async () => ({
        valid: false,
        code: 'outOfDate',
      })

      await GitBridgeApiController.pushSnapshot(req, res)
      expect(statusCalls.length).toBe(1)
      expect(statusCalls[0]).toBe(409)
      expect(jsonCalls[0]).toEqual({
        status: 409,
        code: 'outOfDate',
        message: 'Out of Date',
      })
    })

    it('returns 404 in pushSnapshot if project invalid', async function () {
      req.body = {
        latestVerId: 8,
        files: [],
        postbackUrl: 'http://git-bridge:8000/postback',
      }
      GitBridgeSnapshotManager.validatePushVersion = async () => ({
        valid: false,
        code: 'invalidProject',
      })

      await GitBridgeApiController.pushSnapshot(req, res)
      expect(statusCalls.length).toBe(1)
      expect(statusCalls[0]).toBe(404)
      expect(jsonCalls[0]).toEqual({
        status: 404,
        code: 'invalidProject',
        message: 'Invalid Project',
      })
    })

    it('returns 500 in pushSnapshot if error thrown', async function () {
      req.body = {
        latestVerId: 8,
        files: [],
      }
      GitBridgeSnapshotManager.validatePushVersion = async () => {
        throw new Error('validation error')
      }

      await GitBridgeApiController.pushSnapshot(req, res)
      expect(statusCalls.length).toBe(1)
      expect(statusCalls[0]).toBe(500)
      expect(jsonCalls[0].code).toBe('error')
      expect(jsonCalls[0].message).toBe('internal error')
      expect(jsonCalls[0].errorId).toBeDefined()
    })
  })

  describe('requireBlobAccess', function () {
    const hash = 'a'.repeat(40)
    let next

    beforeEach(function () {
      next = sinon.spy()
      req = {
        headers: {},
        params: { projectId, hash },
        query: {},
        body: {},
      }
      Settings.security = { sessionSecret: 'test-secret-12345' }
    })

    it('calls next() when a valid blob token is provided in query', async function () {
      req.query.token = GitBridgeFileTokenManager.createBlobToken(projectId, hash)
      await GitBridgeApiController.requireBlobAccess(req, res, next)
      expect(next.calledOnce).toBe(true)
      expect(statusCalls).toEqual([])
    })

    it('redacts the blob token from the logged query and URL', async function () {
      const token = GitBridgeFileTokenManager.createBlobToken(projectId, hash)
      req.query.token = token
      req.url = `/api/v0/docs/${projectId}/blob/${hash}?token=${token}`
      await GitBridgeApiController.requireBlobAccess(req, res, next)
      expect(req.query.token).toBe('[REDACTED]')
      expect(req.url).not.toContain(token)
    })

    it('does not accept a blob token for another hash', async function () {
      req.query.token = GitBridgeFileTokenManager.createBlobToken(
        projectId,
        'b'.repeat(40)
      )
      await GitBridgeApiController.requireBlobAccess(req, res, next)
      expect(next.called).toBe(false)
      expect(statusCalls[0]).toBe(401)
    })
  })

  describe('getBlob', function () {
    const hash = 'a'.repeat(40)
    let chunks

    beforeEach(function () {
      chunks = []
      req = { params: { projectId, hash }, query: {}, body: {} }
      res = Object.assign(
        new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(chunk)
            callback()
          },
        }),
        {
          headers: {},
          setHeader(name, value) {
            this.headers[name.toLowerCase()] = value
          },
          status(code) {
            statusCalls.push(code)
            return this
          },
          json(data) {
            jsonCalls.push(data)
            return this
          },
        }
      )
    })

    afterEach(function () {
      sinon.restore()
    })

    it('streams the blob for the project with its length', async function () {
      let requested
      sinon.stub(HistoryManager.promises, 'requestBlobWithProjectId').callsFake(
        async (pId, h) => {
          requested = [pId, h]
          return {
            stream: Readable.from([Buffer.from('png-'), Buffer.from('bytes')]),
            contentLength: 9,
          }
        }
      )

      await GitBridgeApiController.getBlob(req, res)

      expect(requested).toEqual([projectId, hash])
      expect(Buffer.concat(chunks).toString()).toBe('png-bytes')
      expect(res.headers['content-length']).toBe(9)
      expect(res.headers['content-type']).toBe('application/octet-stream')
      expect(statusCalls).toEqual([])
    })

    it('returns 404 when the blob is not in the project history', async function () {
      sinon
        .stub(HistoryManager.promises, 'requestBlobWithProjectId')
        .rejects(new Errors.NotFoundError('no blob'))

      await GitBridgeApiController.getBlob(req, res)

      expect(statusCalls).toEqual([404])
      expect(jsonCalls[0].code).toBe('notFound')
    })

    it('returns 400 for a hash that is not a blob hash', async function () {
      const blobStub = sinon.stub(HistoryManager.promises, 'requestBlobWithProjectId')
      req.params.hash = '../../etc/passwd'

      await GitBridgeApiController.getBlob(req, res)

      expect(statusCalls).toEqual([400])
      expect(blobStub.called).toBe(false)
    })

    it('returns 500 when the history lookup fails unexpectedly', async function () {
      sinon
        .stub(HistoryManager.promises, 'requestBlobWithProjectId')
        .rejects(new Error('history down'))

      await GitBridgeApiController.getBlob(req, res)

      expect(statusCalls).toEqual([500])
      expect(jsonCalls[0].errorId).toBeDefined()
    })
  })
})
