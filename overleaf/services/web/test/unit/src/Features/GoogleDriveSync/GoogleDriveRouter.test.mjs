import { describe, it, beforeEach, vi, expect } from 'vitest'

const modulePath =
  '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveRouter.mjs'

describe('GoogleDriveRouter', function () {
  let GoogleDriveRouter
  let webRouter
  let publicApiRouter

  const Features = {
    hasFeature: vi.fn(),
  }

  const AuthenticationController = {
    requireLogin: vi.fn().mockReturnValue((req, res, next) => next()),
  }

  const AuthorizationMiddleware = {
    ensureUserCanReadProject: vi.fn(),
    ensureUserCanWriteProjectContent: vi.fn(),
  }

  const GoogleDriveController = {
    startOAuth: vi.fn(),
    oauthCallback: vi.fn(),
    unlink: vi.fn(),
    getUserStatus: vi.fn(),
    getProjectStatus: vi.fn(),
    syncProjectNow: vi.fn(),
    scanExistingProjects: vi.fn(),
    dismissConflicts: vi.fn(),
  }

  const GoogleDriveWebhookController = {
    handleWebhook: vi.fn(),
  }

  vi.doMock('../../../../../app/src/infrastructure/Features.mjs', () => ({
    default: Features,
  }))
  vi.doMock(
    '../../../../../app/src/Features/Authentication/AuthenticationController.mjs',
    () => ({
      default: AuthenticationController,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs',
    () => ({
      default: AuthorizationMiddleware,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveController.mjs',
    () => ({
      default: GoogleDriveController,
      ...GoogleDriveController,
    })
  )
  vi.doMock(
    '../../../../../app/src/Features/GoogleDriveSync/GoogleDriveWebhookController.mjs',
    () => ({
      default: GoogleDriveWebhookController,
      ...GoogleDriveWebhookController,
    })
  )

  beforeEach(async function () {
    vi.clearAllMocks()
    Features.hasFeature.mockReturnValue(true)
    AuthenticationController.requireLogin.mockReturnValue((req, res, next) =>
      next()
    )

    webRouter = {
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
      use: vi.fn(),
      csrf: {
        disableDefaultCsrfProtection: vi.fn(),
      },
    }

    publicApiRouter = {
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
      use: vi.fn(),
    }

    const mod = await import(modulePath)
    GoogleDriveRouter = mod.default || mod.GoogleDriveRouter
  })

  it('mounts all GoogleDrive routes onto webRouter and publicApiRouter when the feature is enabled', function () {
    GoogleDriveRouter.apply(webRouter, publicApiRouter)

    // Webhook route and CSRF disable
    expect(webRouter.csrf.disableDefaultCsrfProtection).toHaveBeenCalledWith(
      '/google-drive/webhook',
      'POST'
    )
    expect(publicApiRouter.post).toHaveBeenCalledWith(
      '/google-drive/webhook',
      GoogleDriveWebhookController.handleWebhook
    )

    // 1. OAuth Start
    expect(webRouter.get).toHaveBeenCalledWith(
      '/auth/google-drive/oauth',
      expect.any(Function),
      GoogleDriveController.startOAuth
    )

    // 2. OAuth Callback
    expect(webRouter.get).toHaveBeenCalledWith(
      '/oauth/google-drive/callback',
      expect.any(Function),
      GoogleDriveController.oauthCallback
    )
    expect(webRouter.get).toHaveBeenCalledWith(
      '/auth/google-drive/callback',
      expect.any(Function),
      GoogleDriveController.oauthCallback
    )

    // 3. Unlink Account
    expect(webRouter.post).toHaveBeenCalledWith(
      '/auth/google-drive/unlink',
      expect.any(Function),
      GoogleDriveController.unlink
    )

    // 4. User Status
    expect(webRouter.get).toHaveBeenCalledWith(
      '/auth/google-drive/status',
      expect.any(Function),
      GoogleDriveController.getUserStatus
    )

    // 5. Project Status
    expect(webRouter.get).toHaveBeenCalledWith(
      '/project/:Project_id/google-drive/status',
      expect.any(Function),
      AuthorizationMiddleware.ensureUserCanReadProject,
      GoogleDriveController.getProjectStatus
    )

    // 6. Project Sync Now
    expect(webRouter.post).toHaveBeenCalledWith(
      '/project/:Project_id/google-drive/sync',
      expect.any(Function),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      GoogleDriveController.syncProjectNow
    )

    // 7. Scan for existing Drive projects
    expect(webRouter.post).toHaveBeenCalledWith(
      '/auth/google-drive/scan-existing-projects',
      expect.any(Function),
      GoogleDriveController.scanExistingProjects
    )

    // 8. Dismiss conflicts
    expect(webRouter.post).toHaveBeenCalledWith(
      '/project/:Project_id/google-drive/conflicts/dismiss',
      expect.any(Function),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      GoogleDriveController.dismissConflicts
    )
  })

  it('works without publicApiRouter or webRouter.csrf', function () {
    const plainWebRouter = {
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
    }
    GoogleDriveRouter.apply(plainWebRouter)

    expect(plainWebRouter.get).toHaveBeenCalledWith(
      '/auth/google-drive/oauth',
      expect.any(Function),
      GoogleDriveController.startOAuth
    )
  })

  it('works when publicApiRouter is provided but webRouter.csrf is undefined', function () {
    const plainWebRouter = {
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
    }
    GoogleDriveRouter.apply(plainWebRouter, publicApiRouter)

    expect(publicApiRouter.post).toHaveBeenCalledWith(
      '/google-drive/webhook',
      GoogleDriveWebhookController.handleWebhook
    )
  })

  it('does not mount any routes when Features.hasFeature returns false', function () {
    Features.hasFeature.mockReturnValue(false)
    GoogleDriveRouter.apply(webRouter, publicApiRouter)

    expect(webRouter.get).not.toHaveBeenCalled()
    expect(webRouter.post).not.toHaveBeenCalled()
    expect(webRouter.delete).not.toHaveBeenCalled()
    expect(publicApiRouter.post).not.toHaveBeenCalled()
  })
})
