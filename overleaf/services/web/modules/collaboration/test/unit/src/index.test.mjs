import { vi, describe, it, expect, beforeEach } from 'vitest'

const {
  mockSettings,
  mockCommentController,
  mockTrackChangesController,
  mockPreferencesController,
  mockNotificationHandler,
} = vi.hoisted(() => ({
  mockSettings: { enableCollaboration: undefined },
  mockCommentController: {
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
  mockTrackChangesController: {
    setTrackChangesState: vi.fn(),
    acceptChanges: vi.fn(),
    getAllRanges: vi.fn(),
    getAllChangesUsers: vi.fn(),
  },
  mockPreferencesController: {
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
  },
  mockNotificationHandler: { handleCommentMessageSent: vi.fn() },
}))

vi.mock('@overleaf/settings', () => ({ default: mockSettings }))
vi.mock('../../../app/src/ModuleSettings.mjs', () => ({ default: undefined }))
vi.mock('../../../app/src/CommentController.mjs', () => ({
  default: mockCommentController,
}))
vi.mock('../../../app/src/TrackChangesController.mjs', () => ({
  default: mockTrackChangesController,
}))
vi.mock('../../../app/src/NotificationPreferencesController.mjs', () => ({
  default: mockPreferencesController,
}))
vi.mock(
  '../../../app/src/CommentNotificationHandler.mjs',
  () => mockNotificationHandler
)
vi.mock(
  '../../../../../app/src/Features/Authentication/AuthenticationController.mjs',
  () => ({ default: { requireLogin: vi.fn(() => 'requireLogin') } })
)
vi.mock(
  '../../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs',
  () => ({
    default: {
      blockRestrictedUserFromProject: 'blockRestricted',
      ensureUserCanReadProject: 'canRead',
      ensureUserCanWriteProjectContent: 'canWrite',
      ensureUserCanWriteOrReviewProjectContent: 'canWriteOrReview',
      ensureUserCanDeleteOrResolveThread: 'canManageThread',
    },
  })
)
vi.mock(
  '../../../../../app/src/Features/Authorization/PermissionsController.mjs',
  () => ({ default: { requirePermission: vi.fn(p => `perm:${p}`) } })
)
vi.mock(
  '../../../../../app/src/Features/Security/RateLimiterMiddleware.mjs',
  () => ({ default: { rateLimit: vi.fn(() => 'rateLimit') } })
)
vi.mock('../../../../../app/src/infrastructure/RateLimiter.mjs', () => ({
  RateLimiter: vi.fn(),
}))

async function applyRoutes() {
  vi.resetModules()
  const mod = (await import('../../../index.mjs')).default
  const routes = []
  const record =
    method =>
    (path, ...handlers) =>
      routes.push({ method, path, handlers })
  mod.router.apply({
    get: record('get'),
    post: record('post'),
    delete: record('delete'),
  })
  return routes
}

function find(routes, method, path) {
  return routes.find(r => r.method === method && r.path === path)
}

describe('collaboration module routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers nothing when disabled', async () => {
    mockSettings.enableCollaboration = false
    expect(await applyRoutes()).toEqual([])
  })

  describe('when enabled', () => {
    let routes
    beforeEach(async () => {
      mockSettings.enableCollaboration = true
      routes = await applyRoutes()
    })

    it('serves every endpoint the review panel calls', () => {
      const expected = [
        ['get', '/project/:project_id/threads'],
        ['get', '/project/:project_id/thread/:thread_id'],
        ['post', '/project/:project_id/thread/:thread_id/messages'],
        [
          'post',
          '/project/:project_id/thread/:thread_id/messages/:message_id/edit',
        ],
        [
          'delete',
          '/project/:project_id/thread/:thread_id/messages/:message_id',
        ],
        [
          'delete',
          '/project/:project_id/thread/:thread_id/own-messages/:message_id',
        ],
        ['post', '/project/:project_id/doc/:doc_id/thread/:thread_id/resolve'],
        ['post', '/project/:project_id/doc/:doc_id/thread/:thread_id/reopen'],
        ['delete', '/project/:project_id/doc/:doc_id/thread/:thread_id'],
        ['post', '/project/:project_id/thread/:thread_id/resolve'],
        ['post', '/project/:project_id/thread/:thread_id/reopen'],
        ['delete', '/project/:project_id/thread/:thread_id'],
        ['post', '/project/:project_id/track_changes'],
        ['post', '/project/:project_id/doc/:doc_id/changes/accept'],
        ['get', '/project/:project_id/ranges'],
        ['get', '/project/:project_id/changes/users'],
        ['get', '/notifications/preferences/project/:project_id'],
        ['post', '/notifications/preferences/project/:project_id'],
      ]
      for (const [method, path] of expected) {
        expect(find(routes, method, path), `${method} ${path}`).toBeDefined()
      }
      expect(routes).toHaveLength(expected.length)
    })

    it('only lets editors and owners accept changes or toggle tracking', () => {
      for (const path of [
        '/project/:project_id/doc/:doc_id/changes/accept',
        '/project/:project_id/track_changes',
      ]) {
        const { handlers } = find(routes, 'post', path)
        expect(handlers).toContain('canWrite')
        expect(handlers).not.toContain('canWriteOrReview')
      }
    })

    it('lets reviewers comment but not manage other people threads', () => {
      const send = find(
        routes,
        'post',
        '/project/:project_id/thread/:thread_id/messages'
      )
      expect(send.handlers).toContain('canWriteOrReview')
      expect(send.handlers).toContain('rateLimit')
      const resolve = find(
        routes,
        'post',
        '/project/:project_id/doc/:doc_id/thread/:thread_id/resolve'
      )
      expect(resolve.handlers).toContain('canManageThread')
    })

    it('blocks restricted (link view-only) users from review data', () => {
      for (const route of routes.filter(r => r.path.startsWith('/project/'))) {
        expect(route.handlers, route.path).toContain('blockRestricted')
      }
    })
  })

  describe('commentMessageSent hook', () => {
    it('sends notifications when enabled', async () => {
      mockSettings.enableCollaboration = true
      vi.resetModules()
      const mod = (await import('../../../index.mjs')).default
      await mod.hooks.promises.commentMessageSent({ projectId: 'p1' })
      expect(
        mockNotificationHandler.handleCommentMessageSent
      ).toHaveBeenCalledWith({ projectId: 'p1' })
    })

    it('does nothing when disabled', async () => {
      mockSettings.enableCollaboration = false
      vi.resetModules()
      const mod = (await import('../../../index.mjs')).default
      await mod.hooks.promises.commentMessageSent({ projectId: 'p1' })
      expect(
        mockNotificationHandler.handleCommentMessageSent
      ).not.toHaveBeenCalled()
    })
  })
})
