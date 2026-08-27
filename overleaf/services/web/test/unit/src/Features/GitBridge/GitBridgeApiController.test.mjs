import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import sinon from 'sinon'
import GitBridgeApiController from '../../../../../app/src/Features/GitBridge/GitBridgeApiController.mjs'
import GitBridgeSnapshotManager from '../../../../../app/src/Features/GitBridge/GitBridgeSnapshotManager.mjs'

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
      expect(jsonCalls[0]).toEqual({
        code: 'error',
        message: 'DB error',
      })
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
      expect(jsonCalls[0]).toEqual({
        code: 'error',
        message: 'fail',
      })
    })
  })

  describe('getSnapshot', function () {
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
      expect(jsonCalls[0]).toEqual({
        code: 'error',
        message: 'snapshot err',
      })
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
      }
      GitBridgeSnapshotManager.validatePushVersion = async () => {
        throw new Error('validation error')
      }

      await GitBridgeApiController.pushSnapshot(req, res)
      expect(statusCalls.length).toBe(1)
      expect(statusCalls[0]).toBe(500)
      expect(jsonCalls[0]).toEqual({
        code: 'error',
        message: 'validation error',
      })
    })
  })
})
