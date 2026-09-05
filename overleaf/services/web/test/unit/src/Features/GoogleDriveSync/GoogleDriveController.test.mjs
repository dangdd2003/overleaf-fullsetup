import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveController.mjs'

describe('GoogleDriveController', () => {
  let GoogleDriveController
  let req, res

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const SessionManager = {
    getLoggedInUserId: vi.fn(),
    getSessionUser: vi.fn(),
  }

  const GoogleDriveOAuthManager = {
    getAuthorizationUrl: vi.fn(),
    handleOAuthCallback: vi.fn(),
    unlinkAccount: vi.fn(),
  }

  const GoogleDriveSyncManager = {
    getProjectStatus: vi.fn(),
    syncProject: vi.fn(),
    enforceManualSyncCooldown: vi.fn(),
    reconcileExistingDriveProjects: vi.fn(),
  }

  const db = {
    googleDriveProjectStates: {
      updateOne: vi.fn(),
    },
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

  vi.doMock('@overleaf/logger', () => ({ default: logger }))
  vi.doMock('../../../../../app/src/infrastructure/mongodb.mjs', () => ({
    db,
    ObjectId: MockObjectId,
  }))
  vi.doMock(
    '../../../../../app/src/Features/Authentication/SessionManager.mjs',
    () => ({
      default: SessionManager,
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
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveSyncManager.mjs',
    () => ({
      default: GoogleDriveSyncManager,
      ...GoogleDriveSyncManager,
    })
  )

  beforeEach(async () => {
    vi.clearAllMocks()

    req = {
      session: { user: { _id: 'user-123' } },
      body: {},
      params: {},
      query: {},
    }
    res = {
      json: vi.fn(),
      redirect: vi.fn(),
      sendStatus: vi.fn(),
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      send: vi.fn(),
    }

    SessionManager.getLoggedInUserId.mockReturnValue('user-123')
    db.googleDriveProjectStates.updateOne.mockResolvedValue({})
    GoogleDriveSyncManager.enforceManualSyncCooldown.mockResolvedValue({
      allowed: true,
    })
    GoogleDriveSyncManager.reconcileExistingDriveProjects.mockResolvedValue({
      scannedCount: 0,
      createdCount: 0,
      createdProjects: [],
    })

    const mod = await import(modulePath)
    GoogleDriveController = mod.default || mod.GoogleDriveController
  })

  describe('startOAuth', () => {
    it('redirects to the authorization URL from GoogleDriveOAuthManager', async () => {
      const authUrl =
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=client-123&state=state-xyz'
      GoogleDriveOAuthManager.getAuthorizationUrl.mockResolvedValue({
        url: authUrl,
        state: 'state-xyz',
      })

      await GoogleDriveController.startOAuth(req, res)

      expect(GoogleDriveOAuthManager.getAuthorizationUrl).toHaveBeenCalledWith(
        'user-123'
      )
      expect(res.redirect).toHaveBeenCalledWith(authUrl)
    })

    it('handles string return from getAuthorizationUrl', async () => {
      const authUrl =
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=client-123'
      GoogleDriveOAuthManager.getAuthorizationUrl.mockResolvedValue(authUrl)

      await GoogleDriveController.startOAuth(req, res)

      expect(res.redirect).toHaveBeenCalledWith(authUrl)
    })

    it('redirects to login if user is not authenticated', async () => {
      req.session = {}
      SessionManager.getLoggedInUserId.mockReturnValue(null)

      await GoogleDriveController.startOAuth(req, res)

      expect(res.redirect).toHaveBeenCalledWith('/login')
    })

    it('redirects to user settings with error when getAuthorizationUrl throws', async () => {
      GoogleDriveOAuthManager.getAuthorizationUrl.mockRejectedValue(
        new Error('Config missing')
      )

      await GoogleDriveController.startOAuth(req, res)

      expect(res.redirect).toHaveBeenCalledWith(
        '/user/settings?error=google_drive_oauth_failed#project-sync'
      )
    })
  })

  describe('oauthCallback', () => {
    it('redirects to settings with error when query parameter contains error', async () => {
      req.query = { error: 'access_denied' }

      await GoogleDriveController.oauthCallback(req, res)

      expect(res.redirect).toHaveBeenCalledWith(
        '/user/settings?error=google_drive_oauth_denied#project-sync'
      )
    })

    it('redirects to settings with invalid error when code or state is missing', async () => {
      req.query = { code: 'auth-code-123' } // missing state

      await GoogleDriveController.oauthCallback(req, res)

      expect(res.redirect).toHaveBeenCalledWith(
        '/user/settings?error=google_drive_oauth_invalid#project-sync'
      )
    })

    it('redirects to login if user session is missing during callback', async () => {
      req.session = {}
      req.query = { code: 'auth-code-123', state: 'state-xyz' }
      SessionManager.getLoggedInUserId.mockReturnValue(null)

      await GoogleDriveController.oauthCallback(req, res)

      expect(res.redirect).toHaveBeenCalledWith('/login')
    })

    it('successfully handles callback and redirects to user settings project-sync tab', async () => {
      req.query = { code: 'auth-code-123', state: 'state-xyz' }
      GoogleDriveOAuthManager.handleOAuthCallback.mockResolvedValue({
        googleEmail: 'test@example.com',
      })

      await GoogleDriveController.oauthCallback(req, res)

      expect(GoogleDriveOAuthManager.handleOAuthCallback).toHaveBeenCalledWith(
        'user-123',
        'auth-code-123',
        'state-xyz'
      )
      expect(res.redirect).toHaveBeenCalledWith('/user/settings#project-sync')
    })

    it('scans for pre-existing Drive projects right after a successful link', async () => {
      req.query = { code: 'auth-code-123', state: 'state-xyz' }
      GoogleDriveOAuthManager.handleOAuthCallback.mockResolvedValue({
        googleEmail: 'test@example.com',
      })

      await GoogleDriveController.oauthCallback(req, res)

      expect(
        GoogleDriveSyncManager.reconcileExistingDriveProjects
      ).toHaveBeenCalledWith('user-123')
    })

    it('still redirects to settings when the post-link scan fails', async () => {
      req.query = { code: 'auth-code-123', state: 'state-xyz' }
      GoogleDriveOAuthManager.handleOAuthCallback.mockResolvedValue({
        googleEmail: 'test@example.com',
      })
      GoogleDriveSyncManager.reconcileExistingDriveProjects.mockRejectedValue(
        new Error('Drive API error')
      )

      await GoogleDriveController.oauthCallback(req, res)

      expect(res.redirect).toHaveBeenCalledWith('/user/settings#project-sync')
    })

    it('redirects to user settings with error when handleOAuthCallback throws', async () => {
      req.query = { code: 'auth-code-123', state: 'state-xyz' }
      GoogleDriveOAuthManager.handleOAuthCallback.mockRejectedValue(
        new Error('Invalid state')
      )

      await GoogleDriveController.oauthCallback(req, res)

      expect(res.redirect).toHaveBeenCalledWith(
        '/user/settings?error=google_drive_oauth_failed#project-sync'
      )
    })

    it('renders popup callback html with postMessage on success when popup query param is true', async () => {
      req.query = { code: 'auth-code-123', state: 'state-xyz', popup: 'true' }
      GoogleDriveOAuthManager.handleOAuthCallback.mockResolvedValue({
        googleEmail: 'test@example.com',
      })

      await GoogleDriveController.oauthCallback(req, res)

      expect(res.set).toHaveBeenCalledWith(
        'Content-Type',
        'text/html; charset=utf-8'
      )
      expect(res.send).toHaveBeenCalledTimes(1)
      const html = res.send.mock.calls[0][0]
      expect(html).toContain('google-drive:oauth-success')
      expect(html).toContain('window.opener.postMessage')
      expect(html).toContain('window.close()')
      expect(res.redirect).not.toHaveBeenCalled()
    })

    it('renders popup callback html with error postMessage when popup query param is true and oauth fails', async () => {
      req.query = { error: 'access_denied', popup: 'true' }

      await GoogleDriveController.oauthCallback(req, res)

      expect(res.set).toHaveBeenCalledWith(
        'Content-Type',
        'text/html; charset=utf-8'
      )
      expect(res.send).toHaveBeenCalledTimes(1)
      const html = res.send.mock.calls[0][0]
      expect(html).toContain('google-drive:oauth-error')
      expect(html).toContain('google_drive_oauth_denied')
      expect(html).toContain('window.close()')
      expect(res.redirect).not.toHaveBeenCalled()
    })
  })

  describe('unlink', () => {
    it('unlinks Google Drive account and returns success', async () => {
      GoogleDriveOAuthManager.unlinkAccount.mockResolvedValue({
        success: true,
      })

      await GoogleDriveController.unlink(req, res)

      expect(GoogleDriveOAuthManager.unlinkAccount).toHaveBeenCalledWith(
        'user-123'
      )
      expect(res.json).toHaveBeenCalledWith({ success: true })
    })

    it('returns 401 when user is not authenticated', async () => {
      req.session = {}
      SessionManager.getLoggedInUserId.mockReturnValue(null)

      await GoogleDriveController.unlink(req, res)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        code: 'unauthorized',
        message: 'User not logged in',
      })
    })

    it('returns 500 when unlinkAccount fails', async () => {
      GoogleDriveOAuthManager.unlinkAccount.mockRejectedValue(
        new Error('Database error')
      )

      await GoogleDriveController.unlink(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        code: 'error',
        message: 'Database error',
      })
    })
  })

  describe('getProjectStatus', () => {
    it('returns project sync status for valid project ID', async () => {
      req.params.Project_id = 'proj-456'
      const statusData = {
        linked: true,
        driveFolderId: 'folder-123',
        folderName: 'My Paper',
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
        lastError: null,
        isSyncing: false,
        fileCount: 4,
      }
      GoogleDriveSyncManager.getProjectStatus.mockResolvedValue(statusData)

      await GoogleDriveController.getProjectStatus(req, res)

      expect(GoogleDriveSyncManager.getProjectStatus).toHaveBeenCalledWith(
        'proj-456',
        'user-123'
      )
      expect(res.json).toHaveBeenCalledWith(statusData)
    })

    it('supports req.params.project_id casing', async () => {
      req.params.project_id = 'proj-789'
      GoogleDriveSyncManager.getProjectStatus.mockResolvedValue({
        linked: false,
      })

      await GoogleDriveController.getProjectStatus(req, res)

      expect(GoogleDriveSyncManager.getProjectStatus).toHaveBeenCalledWith(
        'proj-789',
        'user-123'
      )
      expect(res.json).toHaveBeenCalledWith({ linked: false })
    })

    it('returns 400 if project ID is missing', async () => {
      req.params = {}

      await GoogleDriveController.getProjectStatus(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({
        code: 'bad_request',
        message: 'Missing project id',
      })
    })

    it('returns 500 when getProjectStatus throws an error', async () => {
      req.params.Project_id = 'proj-456'
      GoogleDriveSyncManager.getProjectStatus.mockRejectedValue(
        new Error('DB read failure')
      )

      await GoogleDriveController.getProjectStatus(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        code: 'error',
        message: 'DB read failure',
      })
    })
  })

  describe('syncProjectNow', () => {
    it('triggers syncProject and returns result', async () => {
      req.params.Project_id = 'proj-456'
      const syncResult = {
        inboundApplied: 2,
        outboundUploaded: 1,
        conflicts: 0,
      }
      GoogleDriveSyncManager.syncProject.mockResolvedValue(syncResult)

      await GoogleDriveController.syncProjectNow(req, res)

      expect(GoogleDriveSyncManager.syncProject).toHaveBeenCalledWith(
        'proj-456',
        'user-123'
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        result: syncResult,
      })
    })

    it('returns 400 when project ID is missing', async () => {
      req.params = {}

      await GoogleDriveController.syncProjectNow(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({
        code: 'bad_request',
        message: 'Missing project id',
      })
    })

    it('returns 500 when syncProject throws an error', async () => {
      req.params.Project_id = 'proj-456'
      GoogleDriveSyncManager.syncProject.mockRejectedValue(
        new Error('Sync failed: lock busy')
      )

      await GoogleDriveController.syncProjectNow(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        code: 'error',
        message: 'Sync failed: lock busy',
      })
    })

    it('checks the manual sync cooldown before triggering a sync', async () => {
      req.params.Project_id = 'proj-456'
      GoogleDriveSyncManager.syncProject.mockResolvedValue({ success: true })

      await GoogleDriveController.syncProjectNow(req, res)

      expect(
        GoogleDriveSyncManager.enforceManualSyncCooldown
      ).toHaveBeenCalledWith('proj-456')
      expect(GoogleDriveSyncManager.syncProject).toHaveBeenCalledWith(
        'proj-456',
        'user-123'
      )
    })

    it('returns 429 without syncing when the cooldown is still active', async () => {
      req.params.Project_id = 'proj-456'
      GoogleDriveSyncManager.enforceManualSyncCooldown.mockResolvedValue({
        allowed: false,
        retryAfterSeconds: 42,
      })

      await GoogleDriveController.syncProjectNow(req, res)

      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.json).toHaveBeenCalledWith({
        code: 'rate_limited',
        message: expect.any(String),
        retryAfterSeconds: 42,
      })
      expect(GoogleDriveSyncManager.syncProject).not.toHaveBeenCalled()
    })

    it('clears the pending queue after a successful full sync', async () => {
      req.params.Project_id = 'proj-456'
      GoogleDriveSyncManager.enforceManualSyncCooldown.mockResolvedValue({
        allowed: true,
      })
      GoogleDriveSyncManager.syncProject.mockResolvedValue({ success: true })

      await GoogleDriveController.syncProjectNow(req, res)

      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: expect.anything() }),
        expect.objectContaining({
          $set: { pendingChanges: {} },
          $unset: { outboundDirtyAt: '' },
        })
      )
    })

    it('leaves the pending queue alone when the sync fails', async () => {
      req.params.Project_id = 'proj-456'
      GoogleDriveSyncManager.enforceManualSyncCooldown.mockResolvedValue({
        allowed: true,
      })
      GoogleDriveSyncManager.syncProject.mockRejectedValue(new Error('nope'))

      await GoogleDriveController.syncProjectNow(req, res)

      expect(db.googleDriveProjectStates.updateOne).not.toHaveBeenCalled()
    })
  })

  describe('scanExistingProjects', () => {
    it('scans and returns the reconciliation summary', async () => {
      const summary = {
        scannedCount: 3,
        createdCount: 2,
        createdProjects: [
          { projectId: 'proj-1', name: 'Paper A' },
          { projectId: 'proj-2', name: 'Paper B' },
        ],
      }
      GoogleDriveSyncManager.reconcileExistingDriveProjects.mockResolvedValue(
        summary
      )

      await GoogleDriveController.scanExistingProjects(req, res)

      expect(
        GoogleDriveSyncManager.reconcileExistingDriveProjects
      ).toHaveBeenCalledWith('user-123')
      expect(res.json).toHaveBeenCalledWith({ success: true, ...summary })
    })

    it('returns 500 when the scan fails', async () => {
      GoogleDriveSyncManager.reconcileExistingDriveProjects.mockRejectedValue(
        new Error('Drive API error')
      )

      await GoogleDriveController.scanExistingProjects(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        code: 'error',
        message: 'Drive API error',
      })
    })
  })

  describe('dismissConflicts', () => {
    it('clears conflicts on googleDriveProjectStates and returns updated status', async () => {
      req.params.Project_id = 'proj-456'
      const updatedStatus = {
        linked: true,
        driveFolderId: 'folder-123',
        folderName: 'My Paper',
        syncStatus: 'idle',
        lastSyncedAt: new Date(),
        lastError: null,
        isSyncing: false,
        fileCount: 4,
        conflicts: [],
      }
      GoogleDriveSyncManager.getProjectStatus.mockResolvedValue(updatedStatus)

      await GoogleDriveController.dismissConflicts(req, res)

      expect(db.googleDriveProjectStates.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: expect.anything() }),
        { $set: { conflicts: [] } }
      )
      expect(GoogleDriveSyncManager.getProjectStatus).toHaveBeenCalledWith(
        'proj-456',
        'user-123'
      )
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        ...updatedStatus,
      })
    })

    it('returns 400 when project id is missing', async () => {
      req.params = {}

      await GoogleDriveController.dismissConflicts(req, res)

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({
        code: 'bad_request',
        message: 'Missing project id',
      })
    })

    it('returns 500 when db update throws an error', async () => {
      req.params.Project_id = 'proj-456'
      db.googleDriveProjectStates.updateOne.mockRejectedValue(
        new Error('Database write failure')
      )

      await GoogleDriveController.dismissConflicts(req, res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({
        code: 'error',
        message: 'Database write failure',
      })
    })
  })
})
