import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

const { mockEmailHandler, mockSettings, mockLogger } = vi.hoisted(() => {
  const mockEmailHandler = {
    sendDeferredEmail: vi.fn(),
    promises: {
      sendEmail: vi.fn(),
    },
  }
  const mockSettings = {
    siteUrl: 'http://localhost',
  }
  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }
  return { mockEmailHandler, mockSettings, mockLogger }
})

vi.mock('../../../../../app/src/Features/Email/EmailHandler.mjs', () => ({
  default: mockEmailHandler,
}))
vi.mock('@overleaf/settings', () => ({ default: mockSettings }))
vi.mock('@overleaf/logger', () => ({ default: mockLogger }))

const CommentEmailBatcher = (
  await import('../../../app/src/CommentEmailBatcher.mjs')
).default

describe('CommentEmailBatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    CommentEmailBatcher._queues.clear()
  })

  afterEach(() => {
    // Clean up any pending timers
    for (const entry of CommentEmailBatcher._queues.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    CommentEmailBatcher._queues.clear()
    vi.useRealTimers()
  })

  describe('queueCommentNotification', () => {
    const recipient = { _id: 'r1', email: 'user@test.com', first_name: 'Bob' }
    const project = { _id: 'p1', name: 'Test Project' }
    const author = { first_name: 'Jane', last_name: 'Doe' }

    it('creates a queue entry for a new recipient+project pair', () => {
      CommentEmailBatcher.queueCommentNotification(
        recipient,
        project,
        author,
        't1',
        'hello',
        false
      )
      const key = CommentEmailBatcher._getQueueKey('r1', 'p1')
      expect(CommentEmailBatcher._queues.has(key)).toBe(true)
      const entry = CommentEmailBatcher._queues.get(key)
      expect(entry.comments).toHaveLength(1)
      expect(entry.comments[0].authorName).toBe('Jane Doe')
    })

    it('appends to existing queue for same recipient+project', () => {
      CommentEmailBatcher.queueCommentNotification(
        recipient,
        project,
        author,
        't1',
        'first',
        false
      )
      CommentEmailBatcher.queueCommentNotification(
        recipient,
        project,
        author,
        't1',
        'second',
        false
      )
      const key = CommentEmailBatcher._getQueueKey('r1', 'p1')
      const entry = CommentEmailBatcher._queues.get(key)
      expect(entry.comments).toHaveLength(2)
    })

    it('uses fallback author name when first_name is missing', () => {
      CommentEmailBatcher.queueCommentNotification(
        recipient,
        project,
        {},
        't1',
        'hello',
        false
      )
      const key = CommentEmailBatcher._getQueueKey('r1', 'p1')
      const entry = CommentEmailBatcher._queues.get(key)
      expect(entry.comments[0].authorName).toBe('A collaborator')
    })
  })

  describe('flushQueue', () => {
    it('sends deferred email with correct template and opts', async () => {
      const recipient = {
        _id: 'r1',
        email: 'user@test.com',
        first_name: 'Bob',
      }
      const project = { _id: 'p1', name: 'My Project' }
      const author = { first_name: 'Jane', last_name: 'Doe' }

      CommentEmailBatcher.queueCommentNotification(
        recipient,
        project,
        author,
        't1',
        'check this',
        true
      )

      await CommentEmailBatcher.flushQueue('r1', 'p1')

      expect(mockEmailHandler.sendDeferredEmail).toHaveBeenCalledWith(
        'commentDigest',
        expect.objectContaining({
          to: 'user@test.com',
          recipientName: 'Bob',
          projectName: 'My Project',
          projectUrl: 'http://localhost/project/p1',
          comments: expect.arrayContaining([
            expect.objectContaining({
              authorName: 'Jane Doe',
              content: 'check this',
              isMention: true,
            }),
          ]),
          hasMention: true,
        }),
        0
      )
    })

    it('does nothing when queue is empty', async () => {
      await CommentEmailBatcher.flushQueue('r1', 'p1')
      expect(mockEmailHandler.sendDeferredEmail).not.toHaveBeenCalled()
    })

    it('skips email when recipient has no email address', async () => {
      const recipient = { _id: 'r1', first_name: 'Bob' }
      const project = { _id: 'p1', name: 'P' }

      CommentEmailBatcher.queueCommentNotification(
        recipient,
        project,
        { first_name: 'A' },
        't1',
        'test',
        false
      )

      await CommentEmailBatcher.flushQueue('r1', 'p1')
      expect(mockEmailHandler.sendDeferredEmail).not.toHaveBeenCalled()
    })

    it('cleans up queue entry after flush', async () => {
      const recipient = {
        _id: 'r1',
        email: 'u@t.com',
        first_name: 'B',
      }
      const project = { _id: 'p1', name: 'P' }

      CommentEmailBatcher.queueCommentNotification(
        recipient,
        project,
        { first_name: 'A' },
        't1',
        'test',
        false
      )

      const key = CommentEmailBatcher._getQueueKey('r1', 'p1')
      expect(CommentEmailBatcher._queues.has(key)).toBe(true)

      await CommentEmailBatcher.flushQueue('r1', 'p1')
      expect(CommentEmailBatcher._queues.has(key)).toBe(false)
    })
  })

  describe('debounce behavior', () => {
    it('triggers flush after debounce interval', async () => {
      const recipient = {
        _id: 'r1',
        email: 'u@t.com',
        first_name: 'B',
      }
      const project = { _id: 'p1', name: 'P' }

      CommentEmailBatcher.queueCommentNotification(
        recipient,
        project,
        { first_name: 'A' },
        't1',
        'test',
        false
      )

      // Advance past debounce window (5 min default)
      await vi.advanceTimersByTimeAsync(CommentEmailBatcher._DEBOUNCE_MS + 100)

      expect(mockEmailHandler.sendDeferredEmail).toHaveBeenCalledOnce()
    })

    it('resets timer when a second comment arrives', async () => {
      const recipient = {
        _id: 'r1',
        email: 'u@t.com',
        first_name: 'B',
      }
      const project = { _id: 'p1', name: 'P' }
      const author = { first_name: 'A' }

      CommentEmailBatcher.queueCommentNotification(
        recipient,
        project,
        author,
        't1',
        'first',
        false
      )

      // Advance 3 minutes - not triggered yet
      await vi.advanceTimersByTimeAsync(180000)
      expect(mockEmailHandler.sendDeferredEmail).not.toHaveBeenCalled()

      // Add second comment
      CommentEmailBatcher.queueCommentNotification(
        recipient,
        project,
        author,
        't1',
        'second',
        false
      )

      // Advance another 3 minutes — first timer would have fired, but
      // the reset timer hasn't elapsed yet
      await vi.advanceTimersByTimeAsync(180000)

      // The accumulated time (6 min) hasn't hit debounce (5 min) from
      // the second queue, but max delay (15 min) ceiling hasn't been reached.
      // The debounce was reset at t=3m, so it fires at t=3m+5m=8m.
      // We're at t=6m, so not yet fired.
      // Actually the delay is min(DEBOUNCE_MS, remainingUntilMax).
      // elapsed = 3m, remainingUntilMax = 12m, delay = min(5m, 12m) = 5m
      // So fires at t=3m+5m=8m. We're at t=6m.
      // Need 2 more minutes:
      await vi.advanceTimersByTimeAsync(120000)

      expect(mockEmailHandler.sendDeferredEmail).toHaveBeenCalledOnce()
      // Both comments should be in the batch
      const call = mockEmailHandler.sendDeferredEmail.mock.calls[0]
      expect(call[1].comments).toHaveLength(2)
    })
  })
})
