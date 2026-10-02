import { vi, describe, it, expect, beforeEach } from 'vitest'

const {
  mockModules,
  mockChatApiHandler,
  mockEditorRealTimeController,
  mockSessionManager,
  mockUserInfoManager,
  mockUserInfoController,
  mockChatManager,
  mockDocumentUpdaterHandler,
} = vi.hoisted(() => {
  const mockModules = {
    promises: {
      hooks: {
        fire: vi.fn().mockResolvedValue([]),
      },
    },
  }
  const mockChatApiHandler = {
    promises: {
      getThreads: vi.fn(),
      getThread: vi.fn(),
      sendComment: vi.fn(),
      resolveThread: vi.fn(),
      reopenThread: vi.fn(),
      deleteThread: vi.fn(),
      editMessage: vi.fn(),
      deleteMessage: vi.fn(),
      deleteUserMessage: vi.fn(),
    },
  }
  const mockEditorRealTimeController = {
    emitToRoom: vi.fn(),
  }
  const mockSessionManager = {
    getLoggedInUserId: vi.fn(),
  }
  const mockUserInfoManager = {
    promises: {
      getPersonalInfo: vi.fn(),
    },
  }
  const mockUserInfoController = {
    formatPersonalInfo: vi.fn(u => ({
      id: u._id || u.id,
      first_name: u.first_name,
      email: u.email,
    })),
  }
  const mockChatManager = {
    promises: {
      injectUserInfoIntoThreads: vi.fn().mockResolvedValue(),
    },
  }
  const mockDocumentUpdaterHandler = {
    promises: {
      resolveThread: vi.fn(),
      reopenThread: vi.fn(),
      deleteThread: vi.fn(),
    },
  }
  return {
    mockDocumentUpdaterHandler,
    mockModules,
    mockChatApiHandler,
    mockEditorRealTimeController,
    mockSessionManager,
    mockUserInfoManager,
    mockUserInfoController,
    mockChatManager,
  }
})

vi.mock('../../../../../app/src/infrastructure/Modules.mjs', () => ({
  default: mockModules,
}))
vi.mock('../../../../../app/src/Features/Chat/ChatApiHandler.mjs', () => ({
  default: mockChatApiHandler,
}))
vi.mock(
  '../../../../../app/src/Features/Editor/EditorRealTimeController.mjs',
  () => ({ default: mockEditorRealTimeController })
)
vi.mock(
  '../../../../../app/src/Features/Authentication/SessionManager.mjs',
  () => ({ default: mockSessionManager })
)
vi.mock('../../../../../app/src/Features/User/UserInfoManager.mjs', () => ({
  default: mockUserInfoManager,
}))
vi.mock('../../../../../app/src/Features/User/UserInfoController.mjs', () => ({
  default: mockUserInfoController,
}))
vi.mock('../../../../../app/src/Features/Chat/ChatManager.mjs', () => ({
  default: mockChatManager,
}))

vi.mock(
  '../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
  () => ({ default: mockDocumentUpdaterHandler })
)

const CommentController = (
  await import('../../../app/src/CommentController.mjs')
).default

function createMockReqRes(overrides = {}) {
  const req = {
    params: {},
    body: {},
    session: {},
    ...overrides.req,
  }
  const res = {
    json: vi.fn(),
    sendStatus: vi.fn(),
    status: vi.fn().mockReturnThis(),
    ...overrides.res,
  }
  return { req, res }
}

describe('CommentController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getThreads', () => {
    it('fetches threads, injects user info, and returns JSON', async () => {
      const threads = { t1: { messages: [] } }
      mockChatApiHandler.promises.getThreads.mockResolvedValue(threads)
      const { req, res } = createMockReqRes({
        req: { params: { project_id: 'proj1' } },
      })

      await CommentController.getThreads(req, res)

      expect(mockChatApiHandler.promises.getThreads).toHaveBeenCalledWith(
        'proj1'
      )
      expect(
        mockChatManager.promises.injectUserInfoIntoThreads
      ).toHaveBeenCalledWith(threads)
      expect(res.json).toHaveBeenCalledWith(threads)
    })
  })

  describe('getThread', () => {
    it('returns 404 when thread is not found', async () => {
      mockChatApiHandler.promises.getThread.mockResolvedValue(null)
      const { req, res } = createMockReqRes({
        req: { params: { project_id: 'proj1', thread_id: 't1' } },
      })

      await CommentController.getThread(req, res)

      expect(res.sendStatus).toHaveBeenCalledWith(404)
    })

    it('returns thread JSON when found', async () => {
      const thread = { id: 't1', messages: [] }
      mockChatApiHandler.promises.getThread.mockResolvedValue(thread)
      const { req, res } = createMockReqRes({
        req: { params: { project_id: 'proj1', thread_id: 't1' } },
      })

      await CommentController.getThread(req, res)

      expect(
        mockChatManager.promises.injectUserInfoIntoThreads
      ).toHaveBeenCalledWith({ t1: thread })
      expect(res.json).toHaveBeenCalledWith(thread)
    })
  })

  describe('sendComment', () => {
    it('sends comment, emits new-comment socket event with (threadId, message), and fires hook', async () => {
      const userId = 'u1'
      mockSessionManager.getLoggedInUserId.mockReturnValue(userId)
      const rawMessage = {
        id: 'msg1',
        user_id: userId,
        content: 'hello',
      }
      mockChatApiHandler.promises.sendComment.mockResolvedValue(rawMessage)
      mockUserInfoManager.promises.getPersonalInfo.mockResolvedValue({
        _id: userId,
        first_name: 'Alice',
        email: 'alice@test.com',
      })

      const { req, res } = createMockReqRes({
        req: {
          params: { project_id: 'proj1', thread_id: 't1' },
          body: { content: 'hello' },
        },
      })

      await CommentController.sendComment(req, res)

      expect(mockChatApiHandler.promises.sendComment).toHaveBeenCalledWith(
        'proj1',
        't1',
        userId,
        'hello'
      )
      expect(mockEditorRealTimeController.emitToRoom).toHaveBeenCalledWith(
        'proj1',
        'new-comment',
        't1',
        expect.objectContaining({
          id: 'msg1',
          content: 'hello',
          user: expect.objectContaining({ first_name: 'Alice' }),
        })
      )
      expect(mockModules.promises.hooks.fire).toHaveBeenCalledWith(
        'commentMessageSent',
        {
          projectId: 'proj1',
          threadId: 't1',
          userId,
          content: 'hello',
          messageId: 'msg1',
        }
      )
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'msg1' })
      )
    })
  })

  describe('resolveThread', () => {
    it('resolves thread and emits resolve-thread with (threadId, user)', async () => {
      const userId = 'u1'
      mockSessionManager.getLoggedInUserId.mockReturnValue(userId)
      mockChatApiHandler.promises.resolveThread.mockResolvedValue()
      mockUserInfoManager.promises.getPersonalInfo.mockResolvedValue({
        _id: userId,
        first_name: 'Bob',
        email: 'bob@test.com',
      })

      const { req, res } = createMockReqRes({
        req: { params: { project_id: 'proj1', thread_id: 't1' } },
      })

      await CommentController.resolveThread(req, res)

      expect(mockChatApiHandler.promises.resolveThread).toHaveBeenCalledWith(
        'proj1',
        't1',
        userId
      )
      expect(mockEditorRealTimeController.emitToRoom).toHaveBeenCalledWith(
        'proj1',
        'resolve-thread',
        't1',
        expect.objectContaining({ id: userId, first_name: 'Bob' })
      )
      expect(res.sendStatus).toHaveBeenCalledWith(204)
    })
  })

  describe('reopenThread', () => {
    it('reopens thread and emits reopen-thread with threadId', async () => {
      mockChatApiHandler.promises.reopenThread.mockResolvedValue()
      const { req, res } = createMockReqRes({
        req: { params: { project_id: 'proj1', thread_id: 't1' } },
      })

      await CommentController.reopenThread(req, res)

      expect(mockChatApiHandler.promises.reopenThread).toHaveBeenCalledWith(
        'proj1',
        't1'
      )
      expect(mockEditorRealTimeController.emitToRoom).toHaveBeenCalledWith(
        'proj1',
        'reopen-thread',
        't1'
      )
      expect(res.sendStatus).toHaveBeenCalledWith(204)
    })
  })

  describe('deleteThread', () => {
    it('deletes thread and emits delete-thread with threadId', async () => {
      mockChatApiHandler.promises.deleteThread.mockResolvedValue()
      const { req, res } = createMockReqRes({
        req: { params: { project_id: 'proj1', thread_id: 't1' } },
      })

      await CommentController.deleteThread(req, res)

      expect(mockChatApiHandler.promises.deleteThread).toHaveBeenCalledWith(
        'proj1',
        't1'
      )
      expect(mockEditorRealTimeController.emitToRoom).toHaveBeenCalledWith(
        'proj1',
        'delete-thread',
        't1'
      )
      expect(res.sendStatus).toHaveBeenCalledWith(204)
    })
  })

  describe('thread state with a doc', () => {
    const params = { project_id: 'proj1', doc_id: 'doc1', thread_id: 'th1' }

    beforeEach(() => {
      mockSessionManager.getLoggedInUserId.mockReturnValue('user1')
      mockUserInfoManager.promises.getPersonalInfo.mockResolvedValue({
        _id: 'user1',
      })
    })

    it('resolveThread also marks the comment resolved in document-updater', async () => {
      const { req, res } = createMockReqRes({ req: { params } })
      await CommentController.resolveThread(req, res)
      expect(mockChatApiHandler.promises.resolveThread).toHaveBeenCalledWith(
        'proj1',
        'th1',
        'user1'
      )
      expect(
        mockDocumentUpdaterHandler.promises.resolveThread
      ).toHaveBeenCalledWith('proj1', 'doc1', 'th1', 'user1')
      expect(res.sendStatus).toHaveBeenCalledWith(204)
    })

    it('reopenThread also reopens the comment in document-updater', async () => {
      const { req, res } = createMockReqRes({ req: { params } })
      await CommentController.reopenThread(req, res)
      expect(
        mockDocumentUpdaterHandler.promises.reopenThread
      ).toHaveBeenCalledWith('proj1', 'doc1', 'th1', 'user1')
      expect(mockEditorRealTimeController.emitToRoom).toHaveBeenCalledWith(
        'proj1',
        'reopen-thread',
        'th1'
      )
    })

    it('deleteThread removes the comment range before the chat thread', async () => {
      const calls = []
      mockDocumentUpdaterHandler.promises.deleteThread.mockImplementation(
        async () => calls.push('doc-updater')
      )
      mockChatApiHandler.promises.deleteThread.mockImplementation(async () =>
        calls.push('chat')
      )
      const { req, res } = createMockReqRes({ req: { params } })
      await CommentController.deleteThread(req, res)
      expect(calls).toEqual(['doc-updater', 'chat'])
      expect(
        mockDocumentUpdaterHandler.promises.deleteThread
      ).toHaveBeenCalledWith('proj1', 'doc1', 'th1', 'user1')
    })

    it('does not delete the chat thread if the range removal fails', async () => {
      mockDocumentUpdaterHandler.promises.deleteThread.mockRejectedValue(
        new Error('boom')
      )
      const { req, res } = createMockReqRes({ req: { params } })
      const next = vi.fn()
      await CommentController.deleteThread(req, res, next)
      expect(mockChatApiHandler.promises.deleteThread).not.toHaveBeenCalled()
      expect(mockEditorRealTimeController.emitToRoom).not.toHaveBeenCalled()
    })

    it('doc-less routes leave document-updater alone', async () => {
      const { req, res } = createMockReqRes({
        req: { params: { project_id: 'proj1', thread_id: 'th1' } },
      })
      await CommentController.resolveThread(req, res)
      await CommentController.deleteThread(req, res)
      expect(
        mockDocumentUpdaterHandler.promises.resolveThread
      ).not.toHaveBeenCalled()
      expect(
        mockDocumentUpdaterHandler.promises.deleteThread
      ).not.toHaveBeenCalled()
    })
  })

  describe('editCommentMessage', () => {
    it('edits message and emits edit-message with (threadId, messageId, content)', async () => {
      const userId = 'u1'
      mockSessionManager.getLoggedInUserId.mockReturnValue(userId)
      mockChatApiHandler.promises.editMessage.mockResolvedValue()

      const { req, res } = createMockReqRes({
        req: {
          params: {
            project_id: 'proj1',
            thread_id: 't1',
            message_id: 'm1',
          },
          body: { content: 'updated' },
        },
      })

      await CommentController.editCommentMessage(req, res)

      expect(mockChatApiHandler.promises.editMessage).toHaveBeenCalledWith(
        'proj1',
        't1',
        'm1',
        userId,
        'updated'
      )
      expect(mockEditorRealTimeController.emitToRoom).toHaveBeenCalledWith(
        'proj1',
        'edit-message',
        't1',
        'm1',
        'updated'
      )
      expect(res.sendStatus).toHaveBeenCalledWith(204)
    })
  })

  describe('deleteCommentMessage', () => {
    it('deletes message and emits delete-message with (threadId, messageId)', async () => {
      const userId = 'u1'
      mockSessionManager.getLoggedInUserId.mockReturnValue(userId)
      mockChatApiHandler.promises.deleteMessage.mockResolvedValue()

      const { req, res } = createMockReqRes({
        req: {
          params: {
            project_id: 'proj1',
            thread_id: 't1',
            message_id: 'm1',
          },
        },
      })

      await CommentController.deleteCommentMessage(req, res)

      expect(mockChatApiHandler.promises.deleteMessage).toHaveBeenCalledWith(
        'proj1',
        't1',
        'm1'
      )
      expect(mockEditorRealTimeController.emitToRoom).toHaveBeenCalledWith(
        'proj1',
        'delete-message',
        't1',
        'm1'
      )
      expect(res.sendStatus).toHaveBeenCalledWith(204)
    })
  })

  describe('deleteOwnCommentMessage', () => {
    it('deletes user own message and emits delete-message with (threadId, messageId)', async () => {
      const userId = 'u1'
      mockSessionManager.getLoggedInUserId.mockReturnValue(userId)
      mockChatApiHandler.promises.deleteUserMessage.mockResolvedValue()

      const { req, res } = createMockReqRes({
        req: {
          params: {
            project_id: 'proj1',
            thread_id: 't1',
            message_id: 'm1',
          },
        },
      })

      await CommentController.deleteOwnCommentMessage(req, res)

      expect(
        mockChatApiHandler.promises.deleteUserMessage
      ).toHaveBeenCalledWith('proj1', 't1', userId, 'm1')
      expect(mockEditorRealTimeController.emitToRoom).toHaveBeenCalledWith(
        'proj1',
        'delete-message',
        't1',
        'm1'
      )
      expect(res.sendStatus).toHaveBeenCalledWith(204)
    })
  })
})
