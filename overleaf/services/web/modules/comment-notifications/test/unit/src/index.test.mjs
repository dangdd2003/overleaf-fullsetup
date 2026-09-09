import { vi, describe, it, expect, beforeEach } from 'vitest'

const { mockSettings, mockHandler, mockController, mockPreferencesController } =
  vi.hoisted(() => ({
    mockSettings: {
      enableCommentNotifications: undefined,
    },
    mockHandler: {
      handleCommentMessageSent: vi.fn(),
    },
    mockController: {
      getThreads: vi.fn(),
      getThread: vi.fn(),
      sendComment: vi.fn(),
      resolveThread: vi.fn(),
      reopenThread: vi.fn(),
      deleteThread: vi.fn(),
      editCommentMessage: vi.fn(),
      deleteCommentMessage: vi.fn(),
      deleteOwnCommentMessage: vi.fn(),
    },
    mockPreferencesController: {
      getPreferences: vi.fn(),
      updatePreferences: vi.fn(),
    },
  }))

vi.mock('@overleaf/settings', () => ({ default: mockSettings }))
vi.mock('../../../app/src/ModuleSettings.mjs', () => ({ default: undefined }))
vi.mock('../../../app/src/CommentEmailTemplate.mjs', () => ({}))
vi.mock('../../../app/src/CommentNotificationHandler.mjs', () => mockHandler)
vi.mock('../../../app/src/CommentController.mjs', () => ({
  default: mockController,
}))
vi.mock('../../../app/src/NotificationPreferencesController.mjs', () => ({
  default: mockPreferencesController,
}))

// Mock middleware chain — index imports these for route wiring
vi.mock(
  '../../../../../app/src/Features/Authentication/AuthenticationController.mjs',
  () => ({
    default: {
      requireLogin: vi.fn(() => vi.fn()),
    },
  })
)
vi.mock(
  '../../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs',
  () => ({
    default: {
      blockRestrictedUserFromProject: vi.fn(),
      ensureUserCanReadProject: vi.fn(),
      ensureUserCanWriteOrReviewProjectContent: vi.fn(),
      ensureUserCanDeleteOrResolveThread: vi.fn(),
    },
  })
)
vi.mock(
  '../../../../../app/src/Features/Authorization/PermissionsController.mjs',
  () => ({
    default: {
      requirePermission: vi.fn(() => vi.fn()),
    },
  })
)
vi.mock(
  '../../../../../app/src/Features/Security/RateLimiterMiddleware.mjs',
  () => ({
    default: {
      rateLimit: vi.fn(() => vi.fn()),
    },
  })
)
vi.mock('../../../../../app/src/infrastructure/RateLimiter.mjs', () => ({
  RateLimiter: vi.fn(),
}))

describe('comment-notifications module index', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports a WebModule with router and hooks when enabled', async () => {
    mockSettings.enableCommentNotifications = true
    const mod = (await import('../../../index.mjs')).default
    expect(mod).toBeDefined()
    expect(mod.router).toBeDefined()
    expect(mod.hooks).toBeDefined()
  })

  it('does not register routes when disabled', async () => {
    mockSettings.enableCommentNotifications = false
    vi.resetModules()
    const mod = (await import('../../../index.mjs')).default
    const webRouter = { get: vi.fn(), post: vi.fn(), delete: vi.fn() }
    mod.router.apply(webRouter)
    expect(webRouter.get).not.toHaveBeenCalled()
    expect(webRouter.post).not.toHaveBeenCalled()
  })

  it('registers thread routes when enabled', async () => {
    mockSettings.enableCommentNotifications = true
    vi.resetModules()
    const mod = (await import('../../../index.mjs')).default
    const webRouter = { get: vi.fn(), post: vi.fn(), delete: vi.fn() }
    mod.router.apply(webRouter)

    // Verify GET routes
    expect(webRouter.get).toHaveBeenCalledWith(
      '/project/:project_id/threads',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.getThreads
    )
    expect(webRouter.get).toHaveBeenCalledWith(
      '/project/:project_id/thread/:thread_id',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.getThread
    )

    // Verify POST routes (messages, resolve, reopen, edit)
    expect(webRouter.post).toHaveBeenCalledWith(
      '/project/:project_id/thread/:thread_id/messages',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.sendComment
    )
    expect(webRouter.post).toHaveBeenCalledWith(
      '/project/:project_id/thread/:thread_id/resolve',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.resolveThread
    )
    expect(webRouter.post).toHaveBeenCalledWith(
      '/project/:project_id/doc/:doc_id/thread/:thread_id/resolve',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.resolveThread
    )
    expect(webRouter.post).toHaveBeenCalledWith(
      '/project/:project_id/thread/:thread_id/reopen',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.reopenThread
    )
    expect(webRouter.post).toHaveBeenCalledWith(
      '/project/:project_id/doc/:doc_id/thread/:thread_id/reopen',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.reopenThread
    )
    expect(webRouter.post).toHaveBeenCalledWith(
      '/project/:project_id/thread/:thread_id/messages/:message_id/edit',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.editCommentMessage
    )

    // Verify DELETE routes
    expect(webRouter.delete).toHaveBeenCalledWith(
      '/project/:project_id/thread/:thread_id',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.deleteThread
    )
    expect(webRouter.delete).toHaveBeenCalledWith(
      '/project/:project_id/doc/:doc_id/thread/:thread_id',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.deleteThread
    )
    expect(webRouter.delete).toHaveBeenCalledWith(
      '/project/:project_id/thread/:thread_id/messages/:message_id',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.deleteCommentMessage
    )
    expect(webRouter.delete).toHaveBeenCalledWith(
      '/project/:project_id/thread/:thread_id/own-messages/:message_id',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockController.deleteOwnCommentMessage
    )

    // Verify preferences routes
    expect(webRouter.get).toHaveBeenCalledWith(
      '/notifications/preferences/project/:project_id',
      expect.anything(),
      expect.anything(),
      mockPreferencesController.getPreferences
    )
    expect(webRouter.post).toHaveBeenCalledWith(
      '/notifications/preferences/project/:project_id',
      expect.anything(),
      expect.anything(),
      mockPreferencesController.updatePreferences
    )
  })

  it('hooks.promises.commentMessageSent calls handler when enabled', async () => {
    mockSettings.enableCommentNotifications = true
    const mod = (await import('../../../index.mjs')).default
    await mod.hooks.promises.commentMessageSent({ projectId: 'p1' })
    expect(mockHandler.handleCommentMessageSent).toHaveBeenCalledWith({
      projectId: 'p1',
    })
  })

  it('hooks.promises.commentMessageSent does nothing when disabled', async () => {
    mockSettings.enableCommentNotifications = false
    const mod = (await import('../../../index.mjs')).default
    await mod.hooks.promises.commentMessageSent({ projectId: 'p1' })
    expect(mockHandler.handleCommentMessageSent).not.toHaveBeenCalled()
  })
})
