import { vi, describe, it, expect, beforeEach } from 'vitest'

const {
  mockProjectGetter,
  mockChatApiHandler,
  mockUserGetter,
  mockNotificationsHandler,
  mockLogger,
  mockNotificationPreferences,
} = vi.hoisted(() => {
  const mockProjectGetter = {
    promises: { getProject: vi.fn() },
  }
  const mockChatApiHandler = {
    promises: { getThread: vi.fn() },
  }
  const mockUserGetter = {
    promises: { getUser: vi.fn() },
  }
  const mockNotificationsHandler = {
    promises: { createNotification: vi.fn() },
  }
  const mockLogger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }
  const mockNotificationPreferences = {
    getUserProjectPreferences: vi.fn().mockResolvedValue({
      muteAllNotifications: false,
      repliesOnParticipatingThread: true,
      repliesOnAuthoredThread: true,
      commentOnOwnProject: true,
      commentOnInvitedProject: false,
    }),
  }
  return {
    mockProjectGetter,
    mockChatApiHandler,
    mockUserGetter,
    mockNotificationsHandler,
    mockLogger,
    mockNotificationPreferences,
  }
})

// Mock paths as resolved from the handler's location
// Handler is at modules/comment-notifications/app/src/CommentNotificationHandler.mjs
// It imports ../../../../app/src/Features/X → resolves to app/src/Features/X
// From test at modules/comment-notifications/test/unit/src/ → ../../../../../app/src/Features/X
vi.mock('../../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
  default: mockProjectGetter,
}))
vi.mock('../../../../../app/src/Features/Chat/ChatApiHandler.mjs', () => ({
  default: mockChatApiHandler,
}))
vi.mock('../../../../../app/src/Features/User/UserGetter.mjs', () => ({
  default: mockUserGetter,
}))
vi.mock(
  '../../../../../app/src/Features/Notifications/NotificationsHandler.mjs',
  () => ({ default: mockNotificationsHandler })
)
vi.mock('@overleaf/logger', () => ({ default: mockLogger }))
vi.mock('../../../app/src/NotificationPreferencesController.mjs', () => ({
  default: mockNotificationPreferences,
  getUserProjectPreferences:
    mockNotificationPreferences.getUserProjectPreferences,
}))

const {
  extractMentions,
  resolveRecipients,
  dispatchInAppNotification,
  handleCommentMessageSent,
} = await import('../../../app/src/CommentNotificationHandler.mjs')

describe('CommentNotificationHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('extractMentions', () => {
    it('extracts valid ObjectId mentions from content', () => {
      const content = 'Hello @[507f1f77bcf86cd799439011] check this'
      expect(extractMentions(content)).toEqual(['507f1f77bcf86cd799439011'])
    })

    it('returns empty array for null/undefined content', () => {
      expect(extractMentions(null)).toEqual([])
      expect(extractMentions(undefined)).toEqual([])
    })

    it('returns empty array for content with no mentions', () => {
      expect(extractMentions('hello world')).toEqual([])
    })

    it('deduplicates repeated mentions', () => {
      const content =
        '@[507f1f77bcf86cd799439011] and @[507f1f77bcf86cd799439011]'
      expect(extractMentions(content)).toEqual(['507f1f77bcf86cd799439011'])
    })

    it('extracts multiple distinct mentions', () => {
      const content =
        '@[507f1f77bcf86cd799439011] and @[507f1f77bcf86cd799439012]'
      const result = extractMentions(content)
      expect(result).toHaveLength(2)
      expect(result).toContain('507f1f77bcf86cd799439011')
      expect(result).toContain('507f1f77bcf86cd799439012')
    })
  })

  describe('resolveRecipients', () => {
    const projectId = 'proj123'
    const threadId = 'thread456'
    const authorId = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    const memberId = 'bbbbbbbbbbbbbbbbbbbbbbbb'

    const project = {
      _id: projectId,
      owner_ref: authorId,
      collaberator_refs: [memberId],
      readOnly_refs: [],
      reviewer_refs: [],
    }

    beforeEach(() => {
      mockProjectGetter.promises.getProject.mockResolvedValue(project)
      mockChatApiHandler.promises.getThread.mockResolvedValue({
        messages: [],
      })
      mockUserGetter.promises.getUser.mockResolvedValue({
        _id: memberId,
        first_name: 'Test',
      })
      mockNotificationPreferences.getUserProjectPreferences.mockResolvedValue({
        commentOnOwnProject: true,
        commentOnInvitedProject: false,
        repliesOnParticipatingThread: true,
        muteAllNotifications: false,
      })
    })

    it('excludes the author from recipients', async () => {
      const content = `@[${authorId}]`
      const recipients = await resolveRecipients(
        projectId,
        threadId,
        authorId,
        content
      )
      expect(recipients.every(r => r.user._id !== authorId)).toBe(true)
    })

    it('includes mentioned project members', async () => {
      const content = `@[${memberId}]`
      const recipients = await resolveRecipients(
        projectId,
        threadId,
        authorId,
        content
      )
      expect(recipients).toHaveLength(1)
      expect(recipients[0].isMention).toBe(true)
    })

    it('excludes mentioned users who are not project members', async () => {
      const outsiderId = 'outsider999'
      const content = `@[${outsiderId}]`
      const recipients = await resolveRecipients(
        projectId,
        threadId,
        authorId,
        content
      )
      expect(recipients).toHaveLength(0)
    })

    it('includes thread participants as non-mention recipients', async () => {
      mockChatApiHandler.promises.getThread.mockResolvedValue({
        messages: [{ user_id: memberId }],
      })
      const recipients = await resolveRecipients(
        projectId,
        threadId,
        authorId,
        'no mentions here'
      )
      expect(recipients).toHaveLength(1)
      expect(recipients[0].isMention).toBe(false)
    })

    it('includes project owner on new thread when owner has commentOnOwnProject: true', async () => {
      mockUserGetter.promises.getUser.mockImplementation(async id => {
        if (id === authorId) return { _id: authorId, first_name: 'Owner' }
        if (id === memberId) return { _id: memberId, first_name: 'Member' }
        return null
      })
      mockNotificationPreferences.getUserProjectPreferences.mockResolvedValue({
        commentOnOwnProject: true,
        muteAllNotifications: false,
      })
      // member posts a comment, authorId is project owner
      const recipients = await resolveRecipients(
        projectId,
        threadId,
        memberId, // author is collaborator
        'new thread started'
      )
      expect(recipients.some(r => r.user._id === authorId)).toBe(true)
    })

    it('returns empty when project is not found', async () => {
      mockProjectGetter.promises.getProject.mockResolvedValue(null)
      const recipients = await resolveRecipients(
        projectId,
        threadId,
        authorId,
        'test'
      )
      expect(recipients).toEqual([])
    })

    it('excludes user when muteAllNotifications is true', async () => {
      mockNotificationPreferences.getUserProjectPreferences.mockResolvedValue({
        muteAllNotifications: true,
      })
      const content = `@[${memberId}]`
      const recipients = await resolveRecipients(
        projectId,
        threadId,
        authorId,
        content
      )
      expect(recipients).toHaveLength(0)
    })

    it('handles thread fetch failure gracefully', async () => {
      mockChatApiHandler.promises.getThread.mockRejectedValue(
        new Error('chat down')
      )
      const content = `@[${memberId}]`
      const recipients = await resolveRecipients(
        projectId,
        threadId,
        authorId,
        content
      )
      // should still return mentioned members
      expect(recipients).toHaveLength(1)
      expect(mockLogger.warn).toHaveBeenCalled()
    })
  })

  describe('dispatchInAppNotification', () => {
    it('calls NotificationsHandler.createNotification with correct params', async () => {
      const recipient = { _id: 'recip1' }
      const project = { _id: 'proj1', name: 'My Project' }
      const author = { first_name: 'Jane', last_name: 'Doe' }
      const threadId = 'thread1'
      const content = 'Check this out'

      mockNotificationsHandler.promises.createNotification.mockResolvedValue()

      await dispatchInAppNotification(
        recipient,
        project,
        author,
        threadId,
        content,
        true
      )

      expect(
        mockNotificationsHandler.promises.createNotification
      ).toHaveBeenCalledWith(
        'recip1',
        expect.stringContaining('project-comment-proj1-thread1-recip1'),
        'notification_project_comment',
        expect.objectContaining({
          projectId: 'proj1',
          projectName: 'My Project',
          threadId: 'thread1',
          userName: 'Jane Doe',
          isMention: true,
        }),
        expect.any(String),
        true
      )
    })

    it('truncates long comment content to 120 chars', async () => {
      const longContent = 'x'.repeat(200)
      const recipient = { _id: 'r1' }
      const project = { _id: 'p1', name: 'P' }
      const author = { first_name: 'A' }

      mockNotificationsHandler.promises.createNotification.mockResolvedValue()

      await dispatchInAppNotification(
        recipient,
        project,
        author,
        't1',
        longContent,
        false
      )

      const call =
        mockNotificationsHandler.promises.createNotification.mock.calls[0]
      const messageOpts = call[3]
      expect(messageOpts.commentSnippet.length).toBeLessThanOrEqual(120)
      expect(messageOpts.commentSnippet).toMatch(/\.\.\.$/)
    })

    it('catches and logs errors without throwing', async () => {
      mockNotificationsHandler.promises.createNotification.mockRejectedValue(
        new Error('notifications down')
      )
      const recipient = { _id: 'r1' }
      const project = { _id: 'p1', name: 'P' }
      const author = { first_name: 'A' }

      await expect(
        dispatchInAppNotification(
          recipient,
          project,
          author,
          't1',
          'test',
          false
        )
      ).resolves.not.toThrow()
      expect(mockLogger.warn).toHaveBeenCalled()
    })
  })

  describe('handleCommentMessageSent', () => {
    it('resolves recipients and dispatches notifications', async () => {
      const memberId = 'cccccccccccccccccccccccc'
      const authorId = 'dddddddddddddddddddddddd'
      const projectId = 'proj123'
      const threadId = 'thread456'

      mockUserGetter.promises.getUser.mockImplementation(async id => {
        if (id === authorId)
          return { _id: authorId, first_name: 'Author', last_name: 'A' }
        if (id === memberId)
          return { _id: memberId, first_name: 'Member', last_name: 'M' }
        return null
      })

      mockProjectGetter.promises.getProject.mockResolvedValue({
        _id: projectId,
        name: 'Test Project',
        owner_ref: authorId,
        collaberator_refs: [memberId],
        readOnly_refs: [],
        reviewer_refs: [],
      })

      mockChatApiHandler.promises.getThread.mockResolvedValue({
        messages: [],
      })

      mockNotificationsHandler.promises.createNotification.mockResolvedValue()

      await handleCommentMessageSent({
        projectId,
        threadId,
        userId: authorId,
        content: `Hey @[${memberId}] check this`,
      })

      expect(
        mockNotificationsHandler.promises.createNotification
      ).toHaveBeenCalled()
    })

    it('does nothing when author is not found', async () => {
      mockUserGetter.promises.getUser.mockResolvedValue(null)
      mockProjectGetter.promises.getProject.mockResolvedValue({
        _id: 'p',
        name: 'P',
      })

      await handleCommentMessageSent({
        projectId: 'p',
        threadId: 't',
        userId: 'nobody',
        content: 'test',
      })

      expect(
        mockNotificationsHandler.promises.createNotification
      ).not.toHaveBeenCalled()
    })
  })
})
